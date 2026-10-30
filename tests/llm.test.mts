import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { GatewayError } from "../packages/account-gateway/dist/http/index.js";
import type { NativeResponse } from "../packages/account-gateway/dist/http/index.js";
import type {
  Prepare,
  RequestStatus,
  SafeError,
} from "../packages/account-gateway/dist/contracts/index.js";
import {
  LLM_MAX_REQUEST_BYTES,
  createLlmClient,
  executionConnector,
} from "../packages/account-gateway/dist/llm/index.js";
import type {
  ConsumerControlPort,
  ExecutionPort,
  LlmFailure,
  LlmResult,
  LlmTask,
} from "../packages/account-gateway/dist/llm/index.js";

type Access = Awaited<ReturnType<ConsumerControlPort["runAccess"]>>;
type Request = Parameters<ExecutionPort["request"]>;
type Script = {
  access?: (intent: Prepare) => Promise<Access>;
  request?: (signal: AbortSignal | undefined, ...call: Request) => Promise<NativeResponse>;
  status?: () => Promise<RequestStatus>;
};
type Close = { executionRef: string; operationId: string; reason: string };

const schema = {
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
  additionalProperties: false,
};
function task(overrides: Partial<LlmTask> = {}): LlmTask {
  return {
    taskId: "summary-day-1",
    attempt: 1,
    profileId: "openai-codex-oauth-responses-v1",
    model: "gpt-5.6-sol",
    accountRefs: ["00000000-0000-4000-8000-000000000001"],
    policy: { subjectRef: "subject-a", policyRevision: 2, bindingRevision: 3 },
    instructions: "Return the title.",
    input: "Text to summarize",
    output: { mode: "json_schema", schema },
    maxOutputTokens: 512,
    deadline: new Date(Date.now() + 60_000),
    ...overrides,
  };
}
function grant(intent: Prepare): Access {
  const accountRef = intent.accountRefs[0] ?? "missing";
  return {
    operation: {
      operationRef: intent.operationId,
      state: "applied",
      result: {
        kind: "execution",
        executionRef: "execution-1",
        accountRef,
        authorizationEpoch: 7,
        deadline: intent.deadline,
        state: "active",
      },
    },
    bearer: "fixture-execution-bearer",
    admission: {
      invocationRef: intent.invocationRef,
      attemptRef: intent.attemptRef,
      accountRef,
      authorizationEpoch: 7,
      subjectRef: intent.subjectRef,
      policyRevision: intent.policyRevision,
      bindingRevision: intent.bindingRevision,
      profileId: intent.profileId,
      limits: intent.limits,
      expiresAt: intent.deadline,
    },
  };
}
const event = (body: Record<string, unknown>) => `data: ${JSON.stringify(body)}\n\n`;
const completed = (text: string, extra: Record<string, unknown> = {}) =>
  event({
    type: "response.completed",
    response: {
      id: "resp-1",
      model: "gpt-5.6-sol-2026",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text }] }],
      usage: {
        input_tokens: 40,
        output_tokens: 9,
        input_tokens_details: { cached_tokens: 8 },
        output_tokens_details: { reasoning_tokens: 3 },
      },
      ...extra,
    },
  });
/** Models the SDK stream: bytes in order, then an error or EOF; abort errors it as cancelled. */
function stream(
  signal: AbortSignal | undefined,
  chunks: readonly (string | Uint8Array)[],
  end: "eof" | "hang" | GatewayError = "eof",
): NativeResponse {
  const queue = chunks.map((c) => (typeof c === "string" ? new TextEncoder().encode(c) : c));
  let fail: ((error: unknown) => void) | undefined;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const next = queue.shift();
        if (next) {
          controller.enqueue(next);
        } else if (end === "hang") {
          return new Promise<void>((_resolve, reject) => {
            fail = reject;
          });
        } else if (end === "eof") {
          controller.close();
        } else {
          controller.error(end);
        }
        return Promise.resolve();
      },
    },
    { highWaterMark: 0 },
  );
  signal?.addEventListener("abort", () => {
    fail?.(new GatewayError("cancelled", "effect_unknown"));
  });
  return { kind: "stream", requestRef: "summary-day-1-a1-r", body, cancel: async () => {} };
}
function safe(
  effect: SafeError["effect"],
  code: SafeError["code"],
  retry: SafeError["retry"] = { kind: "never" },
): GatewayError {
  return new GatewayError("safe_error", effect, undefined, undefined, {
    code,
    traceRef: "trace-fixture",
    effect,
    retry,
  });
}
function gateway(script: Script) {
  const prepares: Prepare[] = [];
  const bodies: unknown[] = [];
  const requests: Request[] = [];
  const closes: Close[] = [];
  let statuses = 0;
  const execution: ExecutionPort = {
    async request(...call) {
      requests.push(call);
      bodies.push(JSON.parse(new TextDecoder().decode(call[1].body)));
      return script.request
        ? script.request(call[2]?.signal, ...call)
        : stream(call[2]?.signal, [completed('{"title":"Hello"}')]);
    },
    async status() {
      statuses++;
      if (!script.status) {
        throw new GatewayError("transport", "effect_unknown");
      }
      return script.status();
    },
    async close(executionRef, input) {
      closes.push({ executionRef, ...input });
      return { operationRef: input.operationId, state: "applied" };
    },
  };
  const client = createLlmClient({
    control: {
      runAccess: async (intent) => {
        prepares.push(intent);
        return script.access ? script.access(intent) : grant(intent);
      },
    },
    connectExecution: () => execution,
  });
  return { client, prepares, bodies, requests, closes, statuses: () => statuses };
}
const failure = (result: LlmResult<unknown>): LlmFailure => {
  assert.equal(result.ok, false, JSON.stringify(result));
  return result;
};
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// Regression: the attempt lifecycle drifts from the bound intent, the one native-admitted body or the close.
void test("json_schema task runs access, one bound request, decoded output and close", async () => {
  const fake = gateway({});
  const input = task({ decode: (value) => ({ decoded: value }) });
  const result = await fake.client.generate(input);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.ok);
  assert.deepEqual(result.value, { decoded: { title: "Hello" } });
  assert.equal(result.cleanup, "closed");
  assert.deepEqual(result.usage, {
    inputTokens: 40,
    outputTokens: 9,
    cachedInputTokens: 8,
    reasoningTokens: 3,
  });
  const [intent] = fake.prepares;
  const [call] = fake.requests;
  const [executionRef, native] = call;
  assert.equal(executionRef, "execution-1");
  assert.deepEqual(intent, {
    operationId: "summary-day-1-a1-p",
    invocationRef: "summary-day-1",
    attemptRef: "a1",
    accountRefs: input.accountRefs,
    subjectRef: "subject-a",
    policyRevision: 2,
    bindingRevision: 3,
    profileId: "openai-codex-oauth-responses-v1",
    limits: {
      requests: 1,
      concurrency: 1,
      requestBytes: native.body.byteLength,
      outputBytes: 4 * 1024 * 1024,
      tokens: 512,
    },
    deadline: input.deadline.toISOString(),
  });
  assert.equal(native.requestId, "summary-day-1-a1-r");
  assert.deepEqual(native.admission, grant(intent).admission);
  // Codex OAuth needs service_tier and max_output_tokens; coding plans need the fixed name.
  assert.deepEqual(fake.bodies[0], {
    model: "gpt-5.6-sol",
    instructions: "Return the title.",
    input: [{ role: "user", content: [{ type: "input_text", text: "Text to summarize" }] }],
    stream: true,
    store: false,
    service_tier: "default",
    max_output_tokens: 512,
    text: { format: { type: "json_schema", name: "codex_output_schema", strict: true, schema } },
  });
  assert.deepEqual(result.receipt, {
    executionRef: "execution-1",
    requestRef: "summary-day-1-a1-r",
    accountRef: input.accountRefs[0],
    authorizationEpoch: 7,
    taskId: "summary-day-1",
    attempt: 1,
    profileId: "openai-codex-oauth-responses-v1",
    model: "gpt-5.6-sol",
    observedModel: "gpt-5.6-sol-2026",
    responseId: "resp-1",
    requestSha256: sha256(native.body),
    outputSha256: sha256(new TextEncoder().encode('{"title":"Hello"}')),
  });
  assert.deepEqual(fake.closes, [
    { executionRef: "execution-1", operationId: "summary-day-1-a1-c", reason: "completed" },
  ]);

  // Explicit effort and other modes change only their own fields.
  const other = gateway({
    request: async (signal) => stream(signal, [completed("{}")]),
  });
  await other.client.generate(task({ effort: "high", output: { mode: "json_object" } }));
  await other.client.generate(
    task({
      output: { mode: "text" },
      input: [
        { role: "developer", text: "d" },
        { role: "assistant", text: "a" },
      ],
    }),
  );
  const [object, plain] = other.bodies as Record<string, unknown>[];
  assert.deepEqual(object.reasoning, { effort: "high" });
  assert.deepEqual(object.text, { format: { type: "json_object" } });
  assert.equal("text" in plain, false);
  assert.equal("reasoning" in plain, false);
  assert.deepEqual(plain.input, [
    { role: "developer", content: [{ type: "input_text", text: "d" }] },
    { role: "assistant", content: [{ type: "output_text", text: "a" }] },
  ]);
});

// Regression: a lost stream is reported as a fresh failure, or a pre-dispatch loss is marked as paid.
void test("ambiguous loss reconciles request status before advising a new attempt", async () => {
  const cases: {
    name: string;
    request: Script["request"];
    status?: Script["status"];
    expected: Pick<LlmFailure, "code" | "effect" | "retry">;
  }[] = [
    {
      name: "stream broken, request completed",
      request: async (signal) =>
        stream(
          signal,
          ['data: {"type":"response.output_text.delta","delta":"{"}\n\n'],
          new GatewayError("transport", "effect_unknown"),
        ),
      status: async () => ({
        requestRef: "summary-day-1-a1-r",
        effect: "completed",
        status: "completed",
      }),
      expected: {
        code: "output_lost",
        effect: "completed",
        retry: { kind: "new_attempt", afterMs: 0, mayDuplicateCost: true },
      },
    },
    {
      name: "request transport loss, never dispatched",
      request: async () => {
        throw new GatewayError("transport", "effect_unknown");
      },
      status: async () => ({
        requestRef: "summary-day-1-a1-r",
        effect: "not_dispatched",
        status: "failed",
        error: {
          code: "upstream_failure",
          traceRef: "trace-status",
          effect: "not_dispatched",
          retry: { kind: "after", milliseconds: 250 },
        },
      }),
      expected: {
        code: "unavailable",
        effect: "not_dispatched",
        retry: { kind: "new_attempt", afterMs: 250, mayDuplicateCost: false },
      },
    },
    {
      name: "EOF without terminal event, readback unavailable",
      request: async (signal) => stream(signal, [": keepalive\n\n"]),
      expected: {
        code: "effect_unknown",
        effect: "effect_unknown",
        retry: { kind: "new_attempt", afterMs: 0, mayDuplicateCost: true },
      },
    },
    {
      name: "repeated request returns readback",
      request: async () => ({
        kind: "status",
        status: { requestRef: "summary-day-1-a1-r", effect: "completed", status: "completed" },
      }),
      expected: {
        code: "output_lost",
        effect: "completed",
        retry: { kind: "new_attempt", afterMs: 0, mayDuplicateCost: true },
      },
    },
  ];
  for (const scenario of cases) {
    const fake = gateway({
      request: scenario.request,
      ...(scenario.status ? { status: scenario.status } : {}),
    });
    const result = failure(await fake.client.generate(task()));
    assert.deepEqual(
      { code: result.code, effect: result.effect, retry: result.retry },
      scenario.expected,
      scenario.name,
    );
    assert.equal(result.execution?.executionRef, "execution-1", scenario.name);
    assert.equal(fake.requests.length, 1, scenario.name);
    assert.deepEqual(
      fake.closes.map((c) => c.reason),
      ["failed"],
      scenario.name,
    );
  }
});

// Regression: gateway effects and retry advice collapse into a generic error, or bytes leave before admission.
void test("gateway refusals map by stage and effect without hidden retries", async () => {
  const access: [string, GatewayError, Pick<LlmFailure, "code" | "retry" | "cleanup">][] = [
    [
      "local SDK validation",
      new GatewayError("invalid_input", "not_dispatched"),
      { code: "invalid_task", retry: { kind: "never" }, cleanup: "not_needed" },
    ],
    [
      "lost run-access response",
      new GatewayError("transport", "effect_unknown"),
      { code: "unavailable", retry: { kind: "same_attempt", afterMs: 0 }, cleanup: "pending" },
    ],
    [
      "admission limited",
      safe("not_dispatched", "admission_limited", { kind: "after", milliseconds: 1500 }),
      {
        code: "busy",
        retry: { kind: "new_attempt", afterMs: 1500, mayDuplicateCost: false },
        cleanup: "not_needed",
      },
    ],
    [
      "changed intent",
      safe("not_dispatched", "conflict"),
      {
        code: "conflict",
        retry: { kind: "new_attempt", afterMs: 0, mayDuplicateCost: true },
        cleanup: "not_needed",
      },
    ],
    [
      "denied",
      safe("not_dispatched", "forbidden"),
      { code: "unauthorized", retry: { kind: "never" }, cleanup: "not_needed" },
    ],
    [
      "invalid prepare",
      safe("not_dispatched", "invalid_request"),
      { code: "rejected", retry: { kind: "never" }, cleanup: "not_needed" },
    ],
  ];
  for (const [name, error, expected] of access) {
    const fake = gateway({
      access: async () => {
        throw error;
      },
    });
    const result = failure(await fake.client.generate(task()));
    assert.deepEqual(
      { code: result.code, retry: result.retry, cleanup: result.cleanup },
      expected,
      name,
    );
    assert.equal(result.effect, "not_dispatched", name);
    assert.equal(fake.requests.length + fake.closes.length, 0, name);
  }
  const inference: [string, GatewayError, Pick<LlmFailure, "code" | "effect" | "retry">][] = [
    [
      "rejected before dispatch",
      safe("rejected_before_dispatch", "invalid_request"),
      { code: "rejected", effect: "rejected_before_dispatch", retry: { kind: "never" } },
    ],
    [
      "busy before dispatch",
      safe("not_dispatched", "admission_limited", { kind: "after", milliseconds: 500 }),
      {
        code: "busy",
        effect: "not_dispatched",
        retry: { kind: "new_attempt", afterMs: 500, mayDuplicateCost: false },
      },
    ],
    [
      "provider failed after dispatch",
      safe("dispatch_started", "upstream_failure"),
      {
        code: "provider_failed",
        effect: "dispatch_started",
        retry: { kind: "new_attempt", afterMs: 0, mayDuplicateCost: true },
      },
    ],
  ];
  for (const [name, error, expected] of inference) {
    const fake = gateway({
      request: async () => {
        throw error;
      },
    });
    const result = failure(await fake.client.generate(task()));
    assert.deepEqual(
      { code: result.code, effect: result.effect, retry: result.retry },
      expected,
      name,
    );
    assert.equal(result.traceRef, "trace-fixture", name);
    assert.equal(fake.statuses(), 0, name);
    assert.deepEqual(
      fake.closes.map((c) => c.reason),
      ["failed"],
      name,
    );
  }
  // A grant that differs from the bound intent never receives inference bytes.
  const drifted = gateway({
    access: async (intent) => {
      const issued = grant(intent);
      return {
        ...issued,
        admission: { ...issued.admission, limits: { ...issued.admission.limits, tokens: 9999 } },
      };
    },
  });
  assert.equal(failure(await drifted.client.generate(task())).code, "unavailable");
  assert.equal(drifted.requests.length, 0);
  assert.deepEqual(
    drifted.closes.map((c) => c.reason),
    ["failed"],
  );
  // The native 4 MiB body ceiling and task shape are checked before any gateway call.
  const local = gateway({});
  const oversized = failure(
    await local.client.generate(task({ input: "x".repeat(LLM_MAX_REQUEST_BYTES) })),
  );
  const expired = failure(
    await local.client.generate(task({ deadline: new Date(Date.now() - 1) })),
  );
  const unnamed = failure(await local.client.generate(task({ taskId: "bad id" })));
  for (const result of [oversized, expired, unnamed]) {
    assert.deepEqual(
      { code: result.code, effect: result.effect, cleanup: result.cleanup },
      { code: "invalid_task", effect: "not_dispatched", cleanup: "not_needed" },
    );
  }
  assert.equal(local.prepares.length, 0);
});

// Regression: cancellation or deadline loses the started effect, skips close, or is advised as free.
void test("cancellation and deadline keep the observed effect and close the execution", async () => {
  const started = 'data: {"type":"response.output_text.delta","delta":"{\\"ti"}\n\n';
  const controller = new AbortController();
  const cancelled = gateway({
    request: async (signal) => {
      setTimeout(() => {
        controller.abort();
      }, 20);
      return stream(signal, [started], "hang");
    },
  });
  const byCaller = failure(await cancelled.client.generate(task(), { signal: controller.signal }));
  assert.deepEqual(
    {
      code: byCaller.code,
      effect: byCaller.effect,
      retry: byCaller.retry,
      cleanup: byCaller.cleanup,
    },
    { code: "cancelled", effect: "response_started", retry: { kind: "never" }, cleanup: "closed" },
  );
  assert.deepEqual(
    cancelled.closes.map((c) => c.reason),
    ["cancelled"],
  );

  const slow = gateway({ request: async (signal) => stream(signal, [started], "hang") });
  const byDeadline = failure(
    await slow.client.generate(task({ deadline: new Date(Date.now() + 80) })),
  );
  assert.deepEqual(
    { code: byDeadline.code, effect: byDeadline.effect, retry: byDeadline.retry },
    {
      code: "deadline",
      effect: "response_started",
      retry: { kind: "new_attempt", afterMs: 0, mayDuplicateCost: true },
    },
  );
  assert.deepEqual(
    slow.closes.map((c) => c.reason),
    ["deadline"],
  );

  const early = new AbortController();
  early.abort();
  const idle = gateway({});
  assert.equal(
    failure(await idle.client.generate(task(), { signal: early.signal })).code,
    "cancelled",
  );
  assert.equal(idle.prepares.length, 0);
});

// Regression: split CRLF frames or UTF-8 bytes corrupt output, or terminal outcomes are trusted blindly.
void test("Responses stream reduction is byte-split safe and never trusts an unfinished answer", async () => {
  const frames =
    'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta",\r\ndata: "delta":"Прив"}\r\n\r\n' +
    ": comment\r\n" +
    'data: {"type":"response.output_text.delta","delta":"ет"}\r\n\r\n' +
    completed("", { output: [] }).replaceAll("\n", "\r\n") +
    "data: [DONE]\r\n\r\n";
  const bytes = new TextEncoder().encode(frames);
  const split: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += 7) {
    split.push(bytes.slice(offset, offset + 7));
  }
  const text = gateway({ request: async (signal) => stream(signal, split) });
  const reduced = await text.client.generate(task({ output: { mode: "text" } }));
  assert.ok(reduced.ok, JSON.stringify(reduced));
  assert.equal(reduced.value, "Привет");

  const outcomes: [string, string[], LlmFailure["code"], LlmFailure["effect"]][] = [
    [
      "incomplete",
      [
        event({
          type: "response.incomplete",
          response: {
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            usage: { input_tokens: 1, output_tokens: 512 },
          },
        }),
      ],
      "output_truncated",
      "completed",
    ],
    [
      "failed",
      [event({ type: "response.failed", response: { status: "failed" } })],
      "provider_failed",
      "response_started",
    ],
    [
      "refused",
      [event({ type: "response.refusal.done", refusal: "no" }), completed("")],
      "output_refused",
      "completed",
    ],
    ["not json", [completed("Hello")], "output_invalid", "completed"],
    ["malformed event", ["data: {not json}\n\n"], "provider_failed", "response_started"],
  ];
  for (const [name, chunks, code, effect] of outcomes) {
    const fake = gateway({ request: async (signal) => stream(signal, chunks) });
    const result = failure(await fake.client.generate(task()));
    assert.deepEqual({ code: result.code, effect: result.effect }, { code, effect }, name);
  }
  const truncated = gateway({ request: async (signal) => stream(signal, outcomes[0]?.[1] ?? []) });
  assert.equal(failure(await truncated.client.generate(task())).usage?.outputTokens, 512);
  const rejecting = gateway({});
  const invalid = failure(
    await rejecting.client.generate(
      task({
        decode: () => {
          throw new Error("consumer schema rejected the value");
        },
      }),
    ),
  );
  assert.equal(invalid.code, "output_invalid");
  assert.equal(JSON.stringify(invalid).includes("consumer schema"), false);
});

// Regression: the HTTP connector accepts a malformed origin only after a paid grant exists.
void test("HTTP connector validates origins before issuing any execution client", () => {
  assert.throws(() => executionConnector({ origin: "http://gateway.example" }), GatewayError);
  const connect = executionConnector({ origin: "http://127.0.0.1:1" });
  assert.equal(
    typeof connect({ bearer: "fixture-execution-bearer", timeoutMs: 1000 }).request,
    "function",
  );
});
