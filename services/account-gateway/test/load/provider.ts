// Independent provider process. Its append-only ledger records real TLS entries;
// the driver cannot replace those entries with inferred SQL or SDK success.
import { createServer } from "node:https";
import { readFileSync, openSync, writeSync, closeSync } from "node:fs";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { bounds, check, bounded } from "./model.ts";
import type { LedgerEvent } from "./model.ts";

interface Configuration {
  runId: string;
  cert: string;
  key: string;
  ledger: string;
  credential: string;
  model: string;
}
interface Plan {
  requestId: string;
  mode: "complete" | "held" | "flood";
  delayMs: number;
}
let cfg: Configuration | undefined,
  ledger: number | undefined,
  ledgerBytes = 0,
  sequence = 0,
  total = 0;
const plans = new Map<string, Plan>(),
  release = new Map<string, () => void>();
const sockets = new Set<{ destroy(): void }>();
let server: ReturnType<typeof createServer> | undefined,
  terminating = false;
function emit(value: object) {
  process.stdout.write(JSON.stringify(value) + "\n");
}
function record(event: LedgerEvent["event"], requestId: string, bytes: number) {
  const value: LedgerEvent = { event, requestId, at: Date.now(), bytes, sequence: ++sequence };
  const line = JSON.stringify(value) + "\n";
  ledgerBytes += Buffer.byteLength(line);
  check(ledger !== undefined && ledgerBytes <= bounds.artifactBytes / 4, "provider-ledger-bound");
  writeSync(ledger, line);
  emit(value);
}
async function initialize(configuration: Configuration) {
  check(cfg === undefined && /^[a-f0-9-]{36}$/.test(configuration.runId), "provider-configuration");
  cfg = configuration;
  ledger = openSync(cfg.ledger, "wx", 0o600);
  server = createServer(
    {
      cert: readFileSync(cfg.cert),
      key: readFileSync(cfg.key),
      maxHeaderSize: 16_384,
      headersTimeout: 5000,
      requestTimeout: 5000,
      // Completion loads keep healthy pooled connections for the bounded stand;
      // stop() destroys every socket. Stale-connection faults have a separate gate.
      keepAliveTimeout: bounds.wallMs,
    },
    (req, res) => {
      let requestId = "unidentified",
        bytes = 0,
        closed = false;
      const isClosed = () => closed;
      res.once("close", () => {
        closed = true;
        record("close", requestId, bytes);
        release.get(requestId)?.();
        release.delete(requestId);
      });
      void (async () => {
        const chunks: Buffer[] = [];
        let received = 0;
        for await (const chunk of req as AsyncIterable<Buffer>) {
          received += Buffer.byteLength(chunk);
          check(received <= 1_048_576, "provider-input-bound");
          chunks.push(Buffer.from(chunk));
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        const input = body.input as { role: string; content: string }[];
        check(
          Array.isArray(input) &&
            input.length === 1 &&
            input[0].role === "user" &&
            typeof input[0].content === "string",
          "provider-input",
        );
        const prefix = "load-fixture:" + cfg!.runId + ":";
        check(input[0].content.startsWith(prefix), "provider-run-identity");
        requestId = input[0].content.slice(prefix.length, prefix.length + 36);
        check(/^(?:\nx*)?$/.test(input[0].content.slice(prefix.length + 36)), "provider-padding");
        check(/^[a-f0-9-]{36}$/.test(requestId), "provider-request-identity");
        record("entry", requestId, 0);
        const plan = plans.get(requestId);
        check(plan, "provider-unplanned-entry");
        check(
          req.method === "POST" &&
            req.url === "/v1/responses" &&
            req.headers.authorization === "Bearer " + cfg!.credential &&
            body.model === cfg!.model &&
            body.stream === true &&
            body.store === false &&
            !Object.hasOwn(body, "service_tier") &&
            body.max_output_tokens === 32 &&
            req.headers["x-openai-internal-codex-responses-lite"] === "true",
          "provider-wire",
        );
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        res.flushHeaders();
        record("headers", requestId, bytes);
        let eventSequence = 0;
        const writeWire = async (wire: string) => {
          if (isClosed()) {
            return false;
          }
          const size = Buffer.byteLength(wire);
          bytes += size;
          total += size;
          check(bytes <= bounds.streamBytes && total <= bounds.totalBytes, "provider-output-bound");
          if (!res.write(wire)) {
            record("blocked", requestId, bytes);
            await bounded(
              new Promise<void>((resolve, reject) => {
                const clean = () => {
                  res.off("drain", done);
                  res.off("close", done);
                  res.off("error", error);
                };
                const done = () => {
                    clean();
                    resolve();
                  },
                  error = () => {
                    clean();
                    reject(new Error("load:provider-write"));
                  };
                res.once("drain", done);
                res.once("close", done);
                res.once("error", error);
              }),
              15_000,
              "provider-drain-deadline",
            );
            if (!isClosed()) {
              record("drain", requestId, bytes);
            }
          }
          return !isClosed();
        };
        const frame = (type: string, fields: object) =>
          writeWire(
            "event: " +
              type +
              "\ndata: " +
              JSON.stringify({ type, sequence_number: eventSequence++, ...fields }) +
              "\n\n",
          );
        const text = "controlled fixture completion",
          itemId = "msg_" + requestId.replaceAll("-", "");
        const part = { type: "output_text", text, annotations: [], logprobs: [] };
        const item = {
          id: itemId,
          type: "message",
          status: "completed",
          role: "assistant",
          content: [part],
        };
        const response = {
          id: "resp_" + requestId.replaceAll("-", ""),
          object: "response",
          created_at: 1700000000,
          status: "completed",
          model: cfg!.model,
          store: false,
          service_tier: "default",
          error: null,
          incomplete_details: null,
          output: [item],
          usage: {
            input_tokens: 3,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 2,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 5,
          },
        };
        const pending = { ...response, status: "in_progress", output: [], usage: null };
        await frame("response.created", { response: pending });
        await frame("response.in_progress", { response: pending });
        await frame("response.output_item.added", {
          output_index: 0,
          item: { ...item, status: "in_progress", content: [] },
        });
        await frame("response.content_part.added", {
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          part: { ...part, text: "" },
        });
        if (plan.mode === "flood") {
          // Partial stream deliberately has no terminal completion. It is canceled
          // after the actual pause/resume experiment, never called a success.
          for (let n = 0; n < 4096 && !isClosed() && bytes + 4096 <= bounds.streamBytes; n++) {
            if (
              !(await frame("response.output_text.delta", {
                item_id: itemId,
                output_index: 0,
                content_index: 0,
                delta: "x".repeat(2048),
                logprobs: [],
              }))
            ) {
              return;
            }
          }
          if (!isClosed()) {
            record("budget", requestId, bytes);
            await new Promise<void>((resolve) => {
              release.set(requestId, resolve);
            });
          }
          return;
        }
        await frame("response.output_text.delta", {
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          delta: text,
          logprobs: [],
        });
        if (plan.mode === "held" && !isClosed()) {
          let released = false;
          const isReleased = () => released;
          const done = new Promise<void>((resolve) => {
            release.set(requestId, () => {
              released = true;
              resolve();
            });
          });
          while (!isClosed() && !isReleased()) {
            await Promise.race([done, delay(1000)]);
            if (!isClosed() && !isReleased() && !(await writeWire(": keepalive\n\n"))) {
              return;
            }
          }
        } else if (plan.delayMs) {
          await delay(plan.delayMs);
        }
        if (isClosed()) {
          return;
        }
        await frame("response.output_text.done", {
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          text,
          logprobs: [],
        });
        await frame("response.content_part.done", {
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          part,
        });
        await frame("response.output_item.done", { output_index: 0, item });
        await frame("response.completed", { response });
        res.end();
        record("end", requestId, bytes);
      })().catch(() => {
        if (!isClosed()) {
          record("violation", requestId, bytes);
          res.destroy();
        }
      });
    },
  );
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  check(address !== null && typeof address === "object", "provider-listen");
  emit({ event: "ready", origin: "https://127.0.0.1:" + address.port + "/v1" });
}
async function stop() {
  if (terminating) {
    return;
  }
  terminating = true;
  for (const finish of release.values()) {
    finish();
  }
  release.clear();
  for (const socket of sockets) {
    socket.destroy();
  }
  if (server?.listening === true) {
    await new Promise<void>((resolve) => {
      server!.close(() => {
        resolve();
      });
    });
  }
  if (ledger !== undefined) {
    closeSync(ledger);
  }
  ledger = undefined;
}
const lines = createInterface({ input: process.stdin });
try {
  for await (const line of lines) {
    check(Buffer.byteLength(line) <= 32_768, "provider-command-bound");
    const command = JSON.parse(line) as Record<string, unknown>;
    if (cfg === undefined) {
      await initialize(command as unknown as Configuration);
    } else if (command.command === "arm") {
      const plan = command.plan as Plan | null | undefined;
      check(
        plan !== null &&
          plan !== undefined &&
          /^[a-f0-9-]{36}$/.test(plan.requestId) &&
          !plans.has(plan.requestId) &&
          plans.size < bounds.attempts &&
          ["complete", "held", "flood"].includes(plan.mode) &&
          Number.isSafeInteger(plan.delayMs) &&
          plan.delayMs >= 0 &&
          plan.delayMs <= 10_000,
        "provider-plan",
      );
      plans.set(plan.requestId, plan);
      emit({ event: "armed", requestId: plan.requestId });
    } else if (command.command === "release") {
      release.get(String(command.requestId))?.();
      release.delete(String(command.requestId));
    } else if (command.command === "stop") {
      break;
    } else {
      throw new Error("load:provider-command");
    }
  }
} catch {
  process.exitCode = 1;
  emit({ event: "failed" });
} finally {
  await stop();
}
