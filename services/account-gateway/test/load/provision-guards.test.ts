import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { Agent, request } from "node:https";
import type { Socket } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { bounded } from "./model.ts";
import { childFailureFacts } from "./provision.ts";

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "provider control event deadline");
    await delay(10);
  }
}

void test("completion provider retains the same idle TLS connection between waves and closes it on stop", async () => {
  const root = mkdtempSync("/tmp/ag-load-provider-"),
    cert = join(root, "server.crt"),
    key = join(root, "server.key"),
    ledger = join(root, "ledger.ndjson"),
    runId = randomUUID();
  try {
    const certificate = spawnSync(
      "/usr/bin/openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-keyout",
        key,
        "-out",
        cert,
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-addext",
        "basicConstraints=critical,CA:TRUE",
      ],
      { stdio: "ignore", timeout: 5000 },
    );
    assert.equal(certificate.error, undefined);
    assert.equal(certificate.status, 0);
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./provider.ts", import.meta.url))],
      {
        cwd: "/",
        env: {},
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    child.stdin.on("error", () => {});
    child.on("error", () => {});
    const exited = new Promise<number | null>((resolve) => {
      child.once("close", resolve);
    });
    const events: Record<string, unknown>[] = [];
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      events.push(JSON.parse(line) as Record<string, unknown>);
    });
    const agent = new Agent({ keepAlive: true, maxSockets: 1, ca: readFileSync(cert) });
    const send = (value: object) => child.stdin.write(JSON.stringify(value) + "\n");
    try {
      send({ runId, cert, key, ledger, credential: "fixture-credential", model: "fixture-model" });
      await until(() => events.some((event) => event.event === "ready"));
      const origin = events.find((event) => event.event === "ready")?.origin;
      assert.equal(typeof origin, "string");
      const requestIds: string[] = [];
      async function complete() {
        const requestId = randomUUID();
        requestIds.push(requestId);
        send({ command: "arm", plan: { requestId, mode: "complete", delayMs: 0 } });
        await until(() =>
          events.some((event) => event.event === "armed" && event.requestId === requestId),
        );
        return await bounded(
          new Promise<{
            socket: Socket;
            reused: boolean;
            status: number | undefined;
            body: string;
          }>((resolve, reject) => {
            const outgoing = request(
              String(origin) + "/responses",
              {
                method: "POST",
                agent,
                headers: {
                  authorization: "Bearer fixture-credential",
                  "x-openai-internal-codex-responses-lite": "true",
                },
              },
              (response) => {
                const chunks: Buffer[] = [],
                  socket = response.socket;
                response.on("data", (chunk: Buffer) => {
                  chunks.push(chunk);
                });
                response.once("error", () => {
                  reject(new Error("provider response failed"));
                });
                response.once("end", () => {
                  resolve({
                    socket,
                    reused: outgoing.reusedSocket,
                    status: response.statusCode,
                    body: Buffer.concat(chunks).toString("utf8"),
                  });
                });
              },
            );
            outgoing.once("error", () => {
              reject(new Error("provider request failed"));
            });
            outgoing.end(
              JSON.stringify({
                model: "fixture-model",
                stream: true,
                store: false,
                max_output_tokens: 32,
                input: [{ role: "user", content: "load-fixture:" + runId + ":" + requestId }],
              }),
            );
          }),
          5000,
          "provider-fixture-request",
        );
      }
      const first = await complete();
      assert.equal(first.status, 200);
      assert.match(first.body, /event: response\.completed\n/);
      // The old 1s idle timeout plus Node's 1s buffer evicted this socket.
      await delay(2500);
      assert.equal(
        first.socket.destroyed,
        false,
        "the healthy fixture connection stays open between waves",
      );
      const second = await complete();
      assert.equal(second.status, 200);
      assert.match(second.body, /event: response\.completed\n/);
      assert.equal(second.reused, true);
      assert.equal(second.socket, first.socket, "the next wave uses the same actual TLS socket");
      await until(() => events.filter((event) => event.event === "entry").length === 2);
      assert.deepEqual(
        events.filter((event) => event.event === "entry").map((event) => event.requestId),
        requestIds,
      );
      const closed = new Promise<void>((resolve) => {
        first.socket.once("close", () => {
          resolve();
        });
      });
      child.stdin.end('{"command":"stop"}\n');
      assert.equal(await bounded(exited, 5000, "provider-fixture-stop"), 0);
      await bounded(closed, 5000, "provider-fixture-socket-close");
      assert.equal(first.socket.destroyed, true);
      const entries = readFileSync(ledger, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.deepEqual(
        entries.filter((event) => event.event === "entry").map((event) => event.requestId),
        requestIds,
      );
    } finally {
      agent.destroy();
      child.stdin.end();
      child.kill();
      await bounded(exited, 5000, "provider-fixture-cleanup");
      lines.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("operator rejects unsupported trust modes before any fixture provisioning", () => {
  const root = mkdtempSync("/tmp/ag-load-mode-");
  try {
    for (const mode of ["bind", "host"]) {
      const child = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL("./provision.ts", import.meta.url)),
          "--repo",
          join(root, "source"),
          "--build-receipt",
          join(root, "build.json"),
          "--pg-bin",
          join(root, "postgres"),
          "--artifacts",
          join(root, "artifacts"),
          "--trust-mode",
          mode,
        ],
        { encoding: "utf8", timeout: 10_000, env: { PATH: process.env.PATH } },
      );
      assert.equal(child.error, undefined);
      assert.equal(child.status, 1);
      assert.equal(child.signal, null);
      assert.equal(child.stdout, "");
      const events = child.stderr
        .trim()
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line) as unknown);
      assert.deepEqual(events, [
        {
          event: "fullstack_operator_failure",
          stage: "arguments",
          code: "operator-container-only",
        },
      ]);
      assert.deepEqual(
        readdirSync(root),
        [],
        "an unsupported mode cannot create an artifact directory or fixture",
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("operator failure facts retain only capped sanitized native response records including TAP-prefixed lines", () => {
  const response = {
    event: "gateway_native_response_failure",
    phase: "transport",
    transport_error_reason: "connection_reset",
    upstream_connection: "reused",
    upstream_request_written: false,
    upstream_response_started: false,
    native_entered: true,
  };
  const lines =
    [
      "private-provider-prompt Bearer private-access-token",
      "# " + JSON.stringify(response),
      "    # " +
        JSON.stringify({
          ...response,
          transport_error_reason: "connection_refused",
          upstream_connection: "new",
        }),
      JSON.stringify({ event: "gateway_native_response_failure", phase: "body_read" }),
      JSON.stringify({
        event: "gateway_native_response_failure",
        phase: "transport",
        error: "private-error-body",
      }),
      JSON.stringify({ ...response, transport_error_reason: "private-error-token" }),
      JSON.stringify({ ...response, upstream_connection: "private-hostname" }),
      JSON.stringify({ ...response, upstream_request_written: "private-output" }),
      JSON.stringify({
        event: "gateway_native_oauth_connect_failure",
        phase: "exchange_transport",
      }),
      ...Array.from({ length: 12 }, () => "# " + JSON.stringify(response)),
    ].join("\n") + "\n";
  const facts = childFailureFacts(lines, { exitCode: 1, timedOut: false, outputOverflow: false });
  assert.equal(facts.nativeResponseFailures.length, 8);
  assert.deepEqual(facts.nativeResponseFailures.slice(0, 3), [
    response,
    { ...response, transport_error_reason: "connection_refused", upstream_connection: "new" },
    { event: "gateway_native_response_failure", phase: "body_read" },
  ]);
  assert.equal(JSON.stringify(facts).includes("private-"), false);
  assert.equal(JSON.stringify(facts).includes("oauth"), false);
  const empty = childFailureFacts("private-oauth-only", {
    exitCode: 1,
    timedOut: false,
    outputOverflow: false,
  });
  assert.deepEqual(empty.nativeResponseFailures, []);
});
void test("operator native diagnostics reject incomplete records and remain inside the existing one-megabyte input cap", () => {
  const response = JSON.stringify({ event: "gateway_native_response_failure", phase: "transport" });
  const status = { exitCode: 1, timedOut: false, outputOverflow: false };
  assert.deepEqual(childFailureFacts(response, status).nativeResponseFailures, []);
  assert.deepEqual(
    childFailureFacts("x".repeat(1_048_576) + "\n" + response + "\n", status)
      .nativeResponseFailures,
    [],
  );
});
