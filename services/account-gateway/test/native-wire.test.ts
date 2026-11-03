// Real loopback TCP only; no SQL, Native service, provider, launcher or credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { config, post, providerQuota } from "../src/native-wire.ts";
import { KernelError } from "../src/domain.ts";

async function peer(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  let requests = 0;
  const failures: unknown[] = [];
  const settlements: Promise<void>[] = [];
  const assertClean = () => {
    assert.deepEqual(failures, [], "HTTP fixture handler failed");
  };
  const server = createServer((req, res) => {
    requests++;
    try {
      settlements.push(
        Promise.resolve(handler(req, res)).catch((error: unknown) => {
          failures.push(error);
          res.destroy();
        }),
      );
    } catch (error) {
      failures.push(error);
      res.destroy();
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const cfg = config({
    origin: "http://127.0.0.1:" + address.port,
    enrollment: {
      originRef: "loopback-origin",
      engineIncarnation: "loopback-engine",
      worker: "00000000-0000-4000-8000-000000000001",
      qualificationRef: "loopback-only",
    },
    consumers: [
      {
        consumerId: "loopback-consumer",
        executionCredential: "loopback-execution-token",
        cleanupCredential: "loopback-cleanup-token",
        callbackCredential: "loopback-callback-token",
      },
    ],
    profiles: [
      {
        profile: "loopback-profile",
        baseURL: "https://fixture.invalid/v1",
        model: "fixture-model",
        qualificationRef: "loopback-only",
        requestBytes: 4096,
        outputBytes: 4096,
        tokens: 100,
        providerTokenUpperBound: 100,
      },
    ],
    timeoutMs: 100,
    maxStreamMs: 1500,
  });
  return {
    cfg,
    requests: () => requests,
    assertClean,
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      await Promise.all(settlements);
      assertClean();
    },
  };
}
const credential = "loopback-execution-token",
  body = Buffer.from("{}");
const route = "/private/native/v1/transports";

// Each case is independently RED before the fix: the 100ms CONTROL idle timeout cuts inference,
// although its explicit remaining-admission duration is 1500ms.
for (const scenario of [
  { name: "delayed headers", headers: 250, gap: 0 },
  { name: "stream gap", headers: 0, gap: 250 },
]) {
  void test(
    "native wire: inference duration permits " + scenario.name + " beyond control timeout",
    { timeout: 5000 },
    async () => {
      const f = await peer(async (req, res) => {
        for await (const _ of req) {
          /* Drain fixture input. */
        }
        await delay(scenario.headers);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: first\n\n");
        await delay(scenario.gap);
        res.end("data: final\n\n");
      });
      let hop: Awaited<ReturnType<typeof post>> | undefined;
      try {
        hop = await post(f.cfg, credential, route, body, undefined, 1500);
        const chunks: Buffer[] = [];
        for await (const chunk of hop.response) {
          chunks.push(Buffer.from(chunk as Uint8Array));
        }
        assert.equal(hop.response.statusCode, 200);
        assert.equal(Buffer.concat(chunks).toString(), "data: first\n\ndata: final\n\n");
        assert.equal(hop.response.complete, true);
        assert.equal(f.requests(), 1);
        f.assertClean();
      } finally {
        hop?.abort();
        await f.stop();
      }
    },
  );
}

void test(
  "native wire: default control duration still rejects a peer withholding headers without retry",
  { timeout: 5000 },
  async () => {
    const seen = Promise.withResolvers<void>();
    const f = await peer(async (req) => {
      for await (const _ of req) {
        /* Drain fixture input. */
      }
      seen.resolve();
    });
    try {
      const pending = post(f.cfg, credential, route + "/read-owner", body);
      const observer = pending.catch(() => {});
      try {
        await seen.promise;
        await assert.rejects(
          pending,
          (error: unknown) => error instanceof KernelError && error.code === "unavailable",
        );
        assert.equal(f.requests(), 1);
        f.assertClean();
      } finally {
        await observer;
      }
    } finally {
      await f.stop();
    }
  },
);

void test(
  "native wire: explicit duration remains a hard deadline despite continuous stream activity",
  { timeout: 5000 },
  async () => {
    let pulse: ReturnType<typeof setInterval> | undefined;
    const f = await peer(async (req, res) => {
      for await (const _ of req) {
        /* Drain fixture input. */
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      pulse = setInterval(() => res.write("data: keepalive\n\n"), 20);
      res.once("close", () => {
        clearInterval(pulse);
      });
    });
    let hop: Awaited<ReturnType<typeof post>> | undefined;
    try {
      hop = await post(f.cfg, credential, route, body, undefined, 400);
      const response = hop.response;
      let chunks = 0;
      await assert.rejects(async () => {
        for await (const _ of response) {
          chunks++;
        }
      });
      assert.ok(chunks > 1);
      assert.equal(response.complete, false);
      assert.equal(f.requests(), 1);
      f.assertClean();
    } finally {
      clearInterval(pulse);
      hop?.abort();
      await f.stop();
    }
  },
);

void test("native wire: provider quota is scoped to a singleton matched private502 receipt", async () => {
  const headers = [
    "X-Gateway-Request-Ref",
    "request-one",
    "X-Gateway-Provider-Quota-Limit",
    "50",
    "X-Gateway-Provider-Quota-Remaining",
    "0",
    "X-Gateway-Provider-Quota-Reset-At",
    "2026-11-05T00:00:00.000Z",
  ];
  for (const scenario of [
    "valid",
    "wrong-request",
    "wrong-status",
    "missing",
    "duplicate",
    "nonzero",
    "overflow",
    "fraction",
    "noncanonical",
    "bad-date",
  ]) {
    const raw = [...headers];
    if (scenario === "missing") {
      raw.splice(4, 2);
    }
    if (scenario === "duplicate") {
      raw.push("x-gateway-provider-quota-limit", "50");
    }
    if (scenario === "nonzero") {
      raw[5] = "1";
    }
    if (scenario === "overflow") {
      raw[3] = "9007199254740992";
    }
    if (scenario === "fraction") {
      raw[3] = "1.5";
    }
    if (scenario === "noncanonical") {
      raw[7] = "2026-11-05T00:00:00Z";
    }
    if (scenario === "bad-date") {
      raw[7] = "private-provider-sentinel";
    }
    const f = await peer(async (req, res) => {
      for await (const _ of req) {
        /* Drain fixture request. */
      }
      res.writeHead(scenario === "wrong-status" ? 429 : 502, raw);
      res.end("private-provider-sentinel");
    });
    try {
      const hop = await post(f.cfg, credential, route, body, new AbortController().signal, 1000);
      const quota = providerQuota(
        hop.response,
        scenario === "wrong-request" ? "another-request" : "request-one",
      );
      assert.deepEqual(
        quota,
        scenario === "valid"
          ? {
              provider: "openrouter",
              limit: 50,
              remaining: 0,
              resetAt: "2026-11-05T00:00:00.000Z",
            }
          : undefined,
        scenario,
      );
      hop.abort();
    } finally {
      await f.stop();
    }
  }
});
