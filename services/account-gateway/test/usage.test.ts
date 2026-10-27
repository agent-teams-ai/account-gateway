import assert from "node:assert/strict";
import test from "node:test";
import { ResponsesUsageCapture, PostgresUsageJournal } from "../src/usage.ts";
import { usageObservation, usageQuery } from "@agent-teams/account-gateway/contracts";

test("terminal SSE usage survives chunk boundaries and keeps inclusive cache/reasoning subdivisions", () => {
  const capture = new ResponsesUsageCapture();
  const event = Buffer.from(
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":13,"output_tokens":7,"input_tokens_details":{"cached_tokens":5},"output_tokens_details":{"reasoning_tokens":3}}}}\r\n\r\n',
  );
  for (const byte of event) capture.push(Uint8Array.of(byte));
  assert.deepEqual(capture.snapshot(), {
    inputTokens: 13,
    outputTokens: 7,
    cachedInputTokens: 5,
    reasoningTokens: 3,
    completeness: "partial",
  });
});
test("aborted stream and malformed metadata remain unknown instead of zeros", () => {
  const capture = new ResponsesUsageCapture();
  capture.push(
    Buffer.from('data: {"type":"response.output_text.delta","delta":"private response"}\n\n'),
  );
  capture.push(
    Buffer.from(
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":-1,"output_tokens":"9"}}}\n\n',
    ),
  );
  assert.deepEqual(capture.snapshot(), {
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    reasoningTokens: null,
    completeness: "partial",
  });
});
test("oversized source frames stop parsing and never make telemetry complete", () => {
  const capture = new ResponsesUsageCapture();
  capture.push(Buffer.alloc(1_048_577, 65));
  capture.push(
    Buffer.from(
      '\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2}}}\n',
    ),
  );
  assert.equal(capture.snapshot().inputTokens, null);
});
test("wire authority rejects arbitrary fields, invalid counters and unbounded queries", () => {
  assert.equal(usageQuery.safeParse({ limit: 101 }).success, false);
  assert.equal(usageQuery.safeParse({ consumerId: "other" }).success, false);
  assert.equal(usageObservation.safeParse({ prompt: "secret" }).success, false);
});
test("cursor signature and tenant binding fail before a database query", async () => {
  const pool = {
    query() {
      throw new Error("must not query");
    },
  };
  const journal = new PostgresUsageJournal(pool as never, Buffer.alloc(32, 7));
  await assert.rejects(journal.list({ consumerId: "one" }, { afterCursor: "forged.signature" }), {
    message: "invalid",
  });
  await assert.rejects(journal.list({ consumerId: "one" }, { limit: 101 }), { message: "invalid" });
});

test("native enrichment accepts known inclusive counters without inventing cost and rejects arbitrary or contradictory fields", async () => {
  const { nativeUsage } = await import("../src/usage.ts");
  const observed = {
    source: "native_provider_response",
    state: "complete",
    inputTokens: 13,
    outputTokens: 7,
    cachedInputTokens: 5,
    reasoningOutputTokens: 3,
    costState: "unknown",
    finalized: true,
  };
  assert.deepEqual(nativeUsage(observed), observed);
  assert.throws(() => nativeUsage({ ...observed, authorization: "secret" }), {
    message: "invalid",
  });
  assert.throws(() => nativeUsage({ ...observed, cachedInputTokens: 14 }), { message: "invalid" });
  assert.throws(() => nativeUsage({ ...observed, reasoningOutputTokens: 8 }), {
    message: "invalid",
  });
  assert.throws(() => nativeUsage({ ...observed, inputTokens: undefined }), { message: "invalid" });
});

test("native authority snapshots the optional usage capability before caller mutation", async () => {
  const { NativeAuthority } = await import("../src/native-authority.ts");
  const uuid = "00000000-0000-4000-8000-000000000001";
  const authority = new NativeAuthority({
    kernel: {} as never,
    store: {} as never,
    config: {
      origin: "http://127.0.0.1:1",
      enrollment: {
        originRef: "origin",
        engineIncarnation: uuid,
        worker: uuid,
        qualificationRef: "fixture",
      },
      consumers: [
        {
          consumerId: "consumer",
          executionCredential: "fixture-execution-token",
          cleanupCredential: "fixture-cleanup-token",
          callbackCredential: "fixture-callback-token",
        },
      ],
      profiles: [
        {
          profile: "profile",
          baseURL: "https://fixture.invalid",
          model: "model",
          qualificationRef: "fixture",
          requestBytes: 4096,
          outputBytes: 4096,
          tokens: 100,
          providerTokenUpperBound: 100,
        },
      ],
    },
  });
  let calls = 0;
  const callback = {
    async admit() {
      return { claim: { status: { requestRef: "request", effect: "not_dispatched" as const } } };
    },
    async effect() {
      return { requestRef: "request", effect: "completed" as const };
    },
    async rejectBeforeDispatch() {
      return { requestRef: "request", effect: "rejected_before_dispatch" as const };
    },
    async closed() {},
    async usage() {
      calls++;
    },
  };
  const first = authority.begin(
    {
      context: { consumerId: "consumer" },
      saved: {
        generation: uuid,
        state: "open",
        dispatchAllowed: true,
        admission: {
          executionRef: uuid,
          issuerEpoch: uuid,
          invocationRef: "invocation",
          attemptRef: "attempt",
          accountRef: uuid,
          authorizationEpoch: 1,
          subjectRef: "subject",
          policyRevision: 1,
          bindingRevision: 1,
          profileId: "profile",
          limits: {
            requests: 1,
            concurrency: 1,
            requestBytes: 4096,
            outputBytes: 4096,
            tokens: 100,
          },
          expiresAt: "2026-10-22T00:00:00Z",
        },
      },
      requestId: "request",
      body: new Uint8Array(),
      signal: new AbortController().signal,
      callback,
    },
    new Uint8Array(),
  );
  callback.usage = async () => {
    throw new Error("mutated callback must not run");
  };
  await first.association.callback.usage!({} as never, {
    source: "native_provider_response",
    state: "unknown",
    costState: "unknown",
    finalized: true,
  });
  assert.equal(calls, 1);
});

test("fallback SSE discards contradictory cache and reasoning subdivisions before persistence", () => {
  const capture = new ResponsesUsageCapture();
  capture.push(
    Buffer.from(
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":2,"input_tokens_details":{"cached_tokens":6},"output_tokens_details":{"reasoning_tokens":3}}}}\n\n',
    ),
  );
  assert.deepEqual(capture.snapshot(), {
    inputTokens: 5,
    outputTokens: 2,
    cachedInputTokens: null,
    reasoningTokens: null,
    completeness: "partial",
  });
});
