// Reimplemented after the earlier uncommitted workspace was lost. This is a
// fresh executable qualification; it does not recover or inherit old receipts.
// AG_LOAD_MANIFEST=/protected/fixture.json node --test --test-isolation=none test/load/stand.ts
import test from "node:test";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, lstatSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Pool } from "pg";
import {
  createManagementClient,
  createConsumerControlClient,
  createExecutionClient,
  GatewayError,
} from "@agent-teams/account-gateway/http";
import type { Admission, Prepare } from "@agent-teams/account-gateway/contracts";
import { close as closeInput } from "@agent-teams/account-gateway/contracts";
import { startService } from "../../src/service.ts";
import type { Service } from "../../src/service.ts";
import type { ServiceConfig } from "../../src/service-config.ts";
import {
  bounds,
  scenarios,
  baselineScenarios,
  check,
  bounded,
  identifier,
  entries,
  reconcile,
  closureProjection,
  safeError,
  arrivalObservation,
  capacityRefusal,
  isNonemptyString,
} from "./model.ts";
import type { Attempt, LedgerEvent, Proof, Scenario, Outcome } from "./model.ts";
import { loadFixture, sourceManifest, sha256 } from "./fixture.ts";
import type { Fixture } from "./fixture.ts";

interface Execution {
  executionRef: string;
  accountRef: string;
  bearer: string;
  admission: Admission;
  prepare: Prepare;
}
interface Prepared {
  input: Prepare;
  closeOperationId: string;
  executionRef?: string;
  execution?: Execution;
  closed?: boolean;
  refused?: boolean;
  closeStage?: string;
  acknowledgementState?: string;
}
interface ScenarioResult {
  scenario: Scenario;
  outcome: Outcome;
  startedAt: number;
  finishedAt: number;
  attempts: number;
  providerEntries: number;
  faults: string[];
  details: Record<string, unknown>;
}
interface SQLRequest {
  id: string;
  execution_ref: string;
  effect: string;
  code: string | null;
  transport_occupied: boolean;
  worker: string | null;
  closure_token: string | null;
  native_origin_ref: string | null;
  engine_incarnation: string | null;
  request_nonce: string | null;
  descriptor_generation: string | null;
}
const workspace = fileURLToPath(new URL("../../../../", import.meta.url));
const profileId = "openai-responses-apikey-v1",
  model = "mimo-test",
  consumerId = "fullstack-load-fixture",
  ownerRef = "load-fixture-owner";
const token = () => randomBytes(32).toString("base64url");
function sdkArtifactManifest() {
  const entrypoints = {
    http: fileURLToPath(import.meta.resolve("@agent-teams/account-gateway/http")),
    contracts: fileURLToPath(import.meta.resolve("@agent-teams/account-gateway/contracts")),
  };
  const root = dirname(dirname(entrypoints.contracts)),
    files: { path: string; sha256: string }[] = [];
  let inspected = 0;
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).toSorted()) {
      if (name === "node_modules") {
        continue;
      }
      const path = join(directory, name),
        state = lstatSync(path);
      check(++inspected <= 512 && !state.isSymbolicLink(), "sdk-artifact-layout");
      if (state.isDirectory()) {
        walk(path);
      } else if (state.isFile() && name.endsWith(".js")) {
        check(files.length < 256 && state.size < bounds.streamBytes, "sdk-artifact-bound");
        files.push({ path: relative(root, path), sha256: sha256(readFileSync(path)) });
      }
    }
  };
  walk(root);
  check(
    files.length > 0 &&
      Object.values(entrypoints).every((path) =>
        files.some((f) => f.path === relative(root, path)),
      ),
    "actual-sdk-entrypoints",
  );
  return {
    entrypoints: {
      http: relative(root, entrypoints.http),
      contracts: relative(root, entrypoints.contracts),
    },
    files,
    sha256: sha256(files.map((f) => f.path + "\0" + f.sha256 + "\n").join("")),
  };
}
async function freeOrigin() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  check(address !== null && typeof address === "object", "free-origin");
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return "http://127.0.0.1:" + address.port;
}
async function until(predicate: () => boolean | Promise<boolean>, ms: number, phase: string) {
  const end = Date.now() + ms;
  while (!(await predicate())) {
    check(Date.now() < end, phase);
    await delay(20);
  }
}
function provider(f: Fixture, credential: string) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./provider.ts", import.meta.url))],
    { cwd: "/", env: {}, stdio: ["pipe", "pipe", "ignore"], detached: false },
  );
  child.stdin.on("error", () => {});
  const events: LedgerEvent[] = [],
    armed = new Set<string>();
  let ready = "",
    failed = false,
    received = 0;
  const exited = new Promise<number | null>((resolve) => {
    child.once("error", () => {
      failed = true;
      resolve(-1);
    });
    child.once("close", resolve);
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      received += Buffer.byteLength(line);
      check(line.length < 4096 && received <= bounds.artifactBytes / 4, "provider-control-bound");
      const value = JSON.parse(line) as LedgerEvent & { origin?: string };
      if ((value.event as string) === "ready") {
        ready = value.origin!;
        return;
      }
      if ((value.event as string) === "armed") {
        armed.add(value.requestId);
        return;
      }
      if ((value.event as string) === "failed") {
        failed = true;
        return;
      }
      check(
        ["entry", "headers", "blocked", "drain", "end", "close", "budget", "violation"].includes(
          value.event,
        ) &&
          Number.isSafeInteger(value.sequence) &&
          value.sequence === events.length + 1,
        "provider-ledger-sequence",
      );
      events.push(value);
    } catch {
      failed = true;
    }
  });
  const send = (value: object) => {
    check(!failed && child.stdin.writable, "provider-unavailable");
    child.stdin.write(JSON.stringify(value) + "\n");
  };
  send({
    runId: f.runId,
    cert: f.tls.cert,
    key: f.tls.key,
    ledger: join(f.artifacts, "provider-ledger.ndjson"),
    credential,
    model,
  });
  return {
    events,
    get failed() {
      return failed;
    },
    async origin() {
      await until(() => !!ready || failed, 5000, "provider-start");
      check(!failed, "provider-start");
      return ready;
    },
    async arm(requestId: string, mode: "complete" | "held" | "flood" | "heavy-held", delayMs: number) {
      send({ command: "arm", plan: { requestId, mode, delayMs } });
      await until(() => armed.has(requestId) || failed, 5000, "provider-arm");
      check(!failed, "provider-arm");
    },
    release(requestId: string) {
      send({ command: "release", requestId });
    },
    async stop() {
      if (child.stdin.writable) {
        child.stdin.end('{"command":"stop"}\n');
      }
      try {
        check((await bounded(exited, 5000, "provider-stop")) === 0, "provider-exit");
      } catch (error) {
        child.kill("SIGKILL");
        await bounded(exited, 1000, "provider-kill").catch(() => {});
        throw error;
      }
    },
  };
}
function body(runId: string, requestId: string, paddingBytes = 0) {
  return Buffer.from(
    JSON.stringify({
      model,
      stream: true,
      store: false,
      service_tier: "default",
      input: [
        {
          role: "user",
          content:
            "load-fixture:" +
            runId +
            ":" +
            requestId +
            (paddingBytes ? "\n" + "x".repeat(paddingBytes) : ""),
        },
      ],
    }),
  );
}
function terminal(bytes: Buffer, expectedText = "controlled fixture completion") {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replaceAll("\r\n", "\n");
  check(text.endsWith("\n\n"), "sse-complete-frame");
  const events = text
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => {
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      return data && data !== "[DONE]" ? (JSON.parse(data) as Record<string, unknown>) : undefined;
    })
    .filter((x) => x !== undefined);
  const end = events.filter((e) => e.type === "response.completed");
  check(
    end.length === 1 &&
      !events.some((e) =>
        ["error", "response.failed", "response.incomplete"].includes(String(e.type)),
      ),
    "sse-terminal",
  );
  const response = end[0].response as Record<string, unknown>,
    usage = response.usage as Record<string, unknown>;
  check(
    response.model === model &&
      response.status === "completed" &&
      usage.input_tokens === 3 &&
      usage.output_tokens === 2 &&
      usage.total_tokens === 5,
    "sse-content-usage",
  );
  const output = response.output as { content?: { text?: string }[] }[] | undefined;
  check(
    Array.isArray(output) &&
      output.length === 1 &&
      output[0].content?.[0]?.text === expectedText,
    "sse-complete-output-text",
  );
  check(
    events
      .filter((e) => e.type === "response.output_text.delta")
      .map((e) => e.delta)
      .join("") === expectedText,
    "sse-delta",
  );
}

function requireCompletions(group: readonly Attempt[], expected?: number) {
  check(
    group.filter((a) => a.effect === "completed").length >= (expected ?? 1),
    "expected-completions",
  );
  check(
    group.every((a) => a.effect === "completed" || capacityRefusal(a)),
    "unexpected-load-effect",
  );
}

void test(
  "bounded actual production service, production native CLI, SDK, PG17.10 and controlled TLS load",
  { timeout: bounds.wallMs },
  async (t) => {
    const manifestPath = process.env.AG_LOAD_MANIFEST;
    check(isNonemptyString(manifestPath), "explicit-manifest-required");
    const f = loadFixture(manifestPath),
      source = sourceManifest(workspace),
      sdkArtifact = sdkArtifactManifest(),
      startedAt = Date.now();
    const eventLoop = monitorEventLoopDelay({ resolution: 20 });
    eventLoop.enable();
    const selector = process.env.AG_LOAD_SCENARIOS;
    check(
      !isNonemptyString(selector) || scenarios.includes(selector as Scenario),
      "scenario-selector",
    );
    const selected: readonly Scenario[] = isNonemptyString(selector)
      ? [selector as Scenario]
      : baselineScenarios;
    const scaled = selected.some((s) =>
      [
        "scale-streams",
        "scale-arrivals",
        "sustained-arrivals",
        "large-context",
        "heavy-output",
      ].includes(s),
    );
    const publicMaxActive = scaled ? 1024 : 16;
    const limits = Object.freeze({
      requests: 256,
      concurrency: scaled ? 64 : 1,
      requestBytes: selected.includes("large-context") ? 1_048_576 : 4096,
      outputBytes: bounds.streamBytes,
      tokens: 32,
    });
    let sequence = 0,
      totalBytes = 0,
      executionCount = 0,
      churnPreparations = 0;
    const next = () => identifier(f.runId, f.seed, ++sequence);
    const attempts: Attempt[] = [],
      results: ScenarioResult[] = [],
      accounts: string[] = [],
      executions: Execution[] = [];
    const prepared: Prepared[] = [],
      cleanupObservations: Record<string, unknown>[] = [];
    const pending = new Set<Promise<Attempt>>(),
      rawSockets = new Set<Socket>();
    const originalProofs = new Map<string, Proof>();
    const samples: Record<string, unknown>[] = [];
    let terminalCounts: Record<string, number> = {};
    let phase: string = "setup",
      sampling = false,
      samplingWork: Promise<void> = Promise.resolve();
    let sampleTimer: ReturnType<typeof setInterval> | undefined;
    const kernel = new Pool({
      connectionString: f.kernelDSN,
      max: 4,
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
      statement_timeout: 5000,
    });
    const nativeDB = new Pool({
      connectionString: f.nativeDSN,
      max: 1,
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
    });
    kernel.on("error", () => {});
    nativeDB.on("error", () => {});
    const dummy = token(),
      upstream = provider(f, dummy);
    let service: Service | undefined, stopped: string | undefined, setupFailure: string | undefined;
    const setupDetails: Record<string, string> = {};
    const managementToken = token(),
      controlToken = token();
    const consumer = {
      consumerId,
      managementCredential: token(),
      executionCredential: token(),
      cleanupCredential: token(),
      callbackCredential: token(),
    };
    let facadeOrigin = "",
      callbackOrigin = "",
      nativeOrigin = "",
      inferenceOrigin = "";
    let management: ReturnType<typeof createManagementClient>,
      control: ReturnType<typeof createConsumerControlClient>;
    async function sample() {
      if (sampling) {
        return;
      }
      sampling = true;
      try {
        const memory = process.memoryUsage(),
          cpu = process.cpuUsage(),
          at = Date.now();
        const observation: Record<string, unknown> = {
          at,
          phase,
          nodeRSS: memory.rss,
          nodeHeapUsed: memory.heapUsed,
          nodeExternal: memory.external,
          nodeCPUUserMicros: cpu.user,
          nodeCPUSystemMicros: cpu.system,
        };
        if (eventLoop.count) {
          Object.assign(observation, {
            eventLoopP99Ms: eventLoop.percentile(99) / 1e6,
            eventLoopMaxMs: eventLoop.max / 1e6,
          });
        }
        eventLoop.reset();
        if (service) {
          try {
            const binding = service.binding,
              stat = readFileSync("/proc/" + binding.pid + "/stat", "utf8");
            const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
            if (fields[19] === binding.birthTicks) {
              observation.nativeUserTicks = Number(fields[11]);
              observation.nativeSystemTicks = Number(fields[12]);
              const status = readFileSync("/proc/" + binding.pid + "/status", "utf8").match(
                /^VmRSS:\s+(\d+) kB$/m,
              );
              if (status) {
                observation.nativeRSS = Number(status[1]) * 1024;
              }
            } else {
              observation.nativeBindingChanged = true;
            }
          } catch {
            observation.nativeUnavailable = true;
          }
        }
        const queryAt = Date.now();
        try {
          const sql = (
            await kernel.query<{ occupied: number; active: number; lock_waiters: number }>(
              `SELECT (SELECT count(*)::int FROM ag_kernel.requests WHERE consumer=$1 AND transport_occupied) AS occupied,
          (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND state='active') AS active,
          (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock') AS lock_waiters`,
              [consumerId],
            )
          ).rows[0];
          Object.assign(observation, {
            sqlOccupied: sql.occupied,
            sqlActive: sql.active,
            sqlLockWaiters: sql.lock_waiters,
            observerQueryMs: Date.now() - queryAt,
          });
        } catch {
          observation.observerUnavailable = true;
        }
        check(samples.length < bounds.wallMs / 100, "resource-sample-bound");
        samples.push(observation);
      } finally {
        sampling = false;
      }
    }
    function save(name: string, value: unknown) {
      const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n");
      check(bytes.length <= bounds.artifactBytes / 4, "artifact-file-bound");
      writeFileSync(join(f.artifacts, name), bytes, { mode: 0o600 });
    }
    async function row(id: string): Promise<SQLRequest | undefined> {
      return (
        await kernel.query<SQLRequest>(
          `SELECT id,execution_ref,effect,code,transport_occupied,worker,closure_token,
      native_origin_ref,engine_incarnation,request_nonce,descriptor_generation FROM ag_kernel.requests WHERE consumer=$1 AND id=$2`,
          [consumerId, id],
        )
      ).rows[0];
    }
    async function readTerminalCounts(): Promise<Record<string, number>> {
      return (
        await kernel.query<Record<string, number>>(
          `SELECT
      (SELECT count(*)::int FROM ag_kernel.executions WHERE consumer=$1 AND state='open') AS open,
      (SELECT count(*)::int FROM ag_kernel.executions WHERE consumer=$1 AND state='closed') AS closed,
      (SELECT count(*)::int FROM ag_kernel.executions WHERE consumer=$1 AND state='fenced') AS fenced,
      (SELECT count(*)::int FROM ag_kernel.requests WHERE consumer=$1 AND transport_occupied) AS occupied,
      (SELECT count(*)::int FROM ag_kernel.cleanup WHERE consumer=$1 AND state<>'done') AS unresolved_cleanup`,
          [consumerId],
        )
      ).rows[0];
    }
    function captureProof(r: SQLRequest): Proof | undefined {
      if (
        !isNonemptyString(r.closure_token) ||
        !isNonemptyString(r.worker) ||
        !isNonemptyString(r.native_origin_ref) ||
        !isNonemptyString(r.engine_incarnation) ||
        !isNonemptyString(r.request_nonce) ||
        !isNonemptyString(r.descriptor_generation)
      ) {
        return;
      }
      const p: Proof = {
        executionRef: r.execution_ref,
        requestRef: r.id,
        worker: r.worker,
        token: r.closure_token,
        native: {
          originRef: r.native_origin_ref,
          engineIncarnation: r.engine_incarnation,
          requestNonce: r.request_nonce,
          generation: r.descriptor_generation,
        },
      };
      const original = originalProofs.get(r.id);
      check(
        !original || JSON.stringify(original) === JSON.stringify(p),
        "original-claim-proof-changed",
      );
      if (!original) {
        originalProofs.set(r.id, p);
      }
      return original ?? p;
    }
    async function observe(a: Attempt) {
      const r = await row(a.requestId);
      a.providerEntries = entries(upstream.events, a.requestId);
      if (!r) {
        return;
      }
      a.effect = r.effect;
      a.sqlCode = r.code ?? undefined;
      a.occupied = r.transport_occupied;
      const p = captureProof(r);
      if (!p) {
        return;
      }
      try {
        const response = await fetch(nativeOrigin + "/private/native/v1/transports/read-owner", {
          method: "POST",
          redirect: "manual",
          headers: {
            authorization: "Bearer " + consumer.executionCredential,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({ proof: p }),
          signal: AbortSignal.timeout(3000),
        });
        check(response.status === 202, "native-owner-read");
        const b = Buffer.from(await response.arrayBuffer());
        check(b.length <= 32_768, "native-read-bound");
        Object.assign(a, closureProjection(JSON.parse(b.toString("utf8")), consumerId, p));
        if (service) {
          check(
            p.native.originRef === service.binding.originRef &&
              p.native.engineIncarnation === service.binding.incarnation,
            "original-live-native-binding",
          );
        }
      } catch {
        a.exactProof = false;
      }
    }
    async function drain(group: readonly Attempt[]) {
      const deadline = Date.now() + bounds.drainMs;
      do {
        // Read-only observation has its own finite concurrency. It must not flood
        // the eight native control handlers whose availability is being measured.
        for (let index = 0; index < group.length; index += 4) {
          await Promise.all(group.slice(index, index + 4).map(observe));
        }
        if (
          group.every(
            (a) =>
              a.occupied !== true &&
              (!entries(upstream.events, a.requestId) ||
                (Boolean(a.nativeClosed) &&
                  Boolean(a.nativeAcknowledged) &&
                  a.exactProof === true)),
          )
        ) {
          return;
        }
        await delay(50);
      } while (Date.now() < deadline);
      throw new Error("load:exact-closure-drain");
    }
    async function prepare(accountRef: string, churn = false): Promise<Execution> {
      if (churn) {
        check(
          ++churnPreparations <= bounds.churnPreparations &&
            executionCount < bounds.executions + bounds.churnPreparations,
          "churn-preparation-bound",
        );
      } else {
        check(executionCount < bounds.executions, "execution-bound");
      }
      const input: Prepare = {
        operationId: next(),
        invocationRef: next(),
        attemptRef: next(),
        accountRefs: [accountRef],
        subjectRef: "load-subject-" + next(),
        policyRevision: 1,
        bindingRevision: 1,
        profileId,
        limits: { ...limits },
        deadline: new Date(startedAt + bounds.wallMs - 30_000).toISOString(),
      };
      const original: Prepared = { input, closeOperationId: next() };
      prepared.push(original);
      try {
        const access = await control.runAccess(input);
        check(
          access.operation.state === "applied" && access.operation.result?.kind === "execution",
          "execution-result",
        );
        executionCount++;
        const execution = {
          executionRef: access.operation.result.executionRef,
          accountRef,
          bearer: access.bearer,
          admission: access.admission,
          prepare: input,
        };
        original.executionRef = execution.executionRef;
        original.execution = execution;
        return execution;
      } catch (error) {
        original.refused = true;
        await recover(original);
        throw error;
      }
    }
    async function recover(original: Prepared) {
      if (isNonemptyString(original.executionRef)) {
        return;
      }
      // Read-only idempotent operation lookup recovers an accepted preparation
      // whose bearer issuance was refused. No second preparation is attempted.
      const operation = await control.operation(original.input.operationId);
      if (operation.state === "applied" && operation.result?.kind === "execution") {
        original.executionRef = operation.result.executionRef;
      }
    }
    async function closePrepared(original: Prepared) {
      if (original.closed === true) {
        return;
      }
      original.closeStage = "recover-original";
      if (!isNonemptyString(original.executionRef)) {
        await recover(original);
      }
      check(isNonemptyString(original.executionRef), "recover-original-preparation");
      const reason = attempts.some(
        (a) => a.executionRef === original.executionRef && a.intentionalCancel !== undefined,
      )
        ? "cancelled"
        : "completed";
      original.closeStage = "validate-close-wire";
      const input = closeInput.parse({ operationId: original.closeOperationId, reason });
      if (original.execution) {
        original.closeStage = "sdk-execution-close";
        const client = createExecutionClient({
          role: "execution",
          origin: callbackOrigin,
          token: original.execution.bearer,
          timeoutMs: 10_000,
        });
        const operation = await client.close(original.executionRef, input);
        original.acknowledgementState = operation.state;
        check(operation.state === "applied", "sdk-close-applied");
      } else {
        // Only cap-denied original refs lack an execution bearer. Their unique
        // original policy subject has existing consumer-control fence authority;
        // fencing it queues real cleanup without manufacturing a bearer or ACK.
        check(Boolean(original.refused), "unissued-close-scope");
        original.closeStage = "sdk-original-subject-fence";
        const operation = await control.fence({
          operationId: input.operationId,
          subjectRef: original.input.subjectRef,
          revision: original.input.policyRevision + 1,
        });
        original.acknowledgementState = operation.state;
        check(
          operation.operationRef === input.operationId && operation.state === "applied",
          "unissued-close-applied",
        );
      }
      original.closed = true;
      original.closeStage = "applied";
    }
    async function closeAndWait(group: readonly Prepared[], name: string) {
      const began = Date.now();
      for (let index = 0; index < group.length; index += 8) {
        await Promise.all(group.slice(index, index + 8).map(closePrepared));
      }
      const refs = group.map((p) => p.executionRef).filter((ref): ref is string => Boolean(ref));
      let counts: Record<string, number> = {};
      await until(
        async () => {
          counts = (
            await kernel.query<Record<string, number>>(
              `SELECT
        (SELECT count(*)::int FROM ag_kernel.executions WHERE consumer=$1 AND ref=ANY($2::uuid[]) AND state='open') AS open,
        (SELECT count(*)::int FROM ag_kernel.executions WHERE consumer=$1 AND ref=ANY($2::uuid[]) AND state='closed') AS closed,
        (SELECT count(*)::int FROM ag_kernel.executions WHERE consumer=$1 AND ref=ANY($2::uuid[]) AND state='fenced') AS fenced,
        (SELECT count(*)::int FROM ag_kernel.requests WHERE consumer=$1 AND execution_ref=ANY($2::uuid[]) AND transport_occupied) AS occupied,
        (SELECT count(*)::int FROM ag_kernel.cleanup WHERE consumer=$1 AND execution_ref=ANY($2::uuid[]) AND state='done') AS done,
        (SELECT count(*)::int FROM ag_kernel.cleanup WHERE consumer=$1 AND execution_ref=ANY($2::uuid[]) AND state<>'done') AS pending`,
              [consumerId, refs],
            )
          ).rows[0];
          return (
            counts.open === 0 &&
            counts.occupied === 0 &&
            counts.pending === 0 &&
            counts.done === refs.length
          );
        },
        bounds.drainMs,
        "durable-cleanup-drain",
      );
      cleanupObservations.push({
        name,
        startedAt: began,
        finishedAt: Date.now(),
        milliseconds: Date.now() - began,
        executions: refs.length,
        ...counts,
        originals: group.map((p) => ({
          preparationOperationId: p.input.operationId,
          executionRef: p.executionRef,
          closeOperationId: p.closeOperationId,
          method: p.execution ? "sdk-execution-close" : "sdk-original-subject-fence",
          applied: p.closed,
        })),
      });
      save("cleanup.json", cleanupObservations);
    }
    async function newAttempt(
      execution: Execution,
      scenario: Scenario,
      mode: "sdk" | "raw-tcp",
      providerMode: "complete" | "held" | "flood" | "heavy-held",
      delayMs: number,
      offeredAt = Date.now(),
    ) {
      check(
        attempts.length < bounds.attempts &&
          Date.now() - startedAt < bounds.wallMs - bounds.drainMs,
        "attempt-bound",
      );
      const a: Attempt = {
        requestId: next(),
        executionRef: execution.executionRef,
        accountRef: execution.accountRef,
        scenario,
        mode,
        offeredAt,
        startedAt: Date.now(),
        bytes: 0,
      };
      attempts.push(a);
      await upstream.arm(a.requestId, providerMode, delayMs);
      return a;
    }
    async function launch(
      execution: Execution,
      scenario: Scenario,
      providerMode: "complete" | "held" | "heavy-held" = "complete",
      delayMs = 0,
      offeredAt = Date.now(),
      signal?: AbortSignal,
    ) {
      const a = await newAttempt(execution, scenario, "sdk", providerMode, delayMs, offeredAt);
      const client = createExecutionClient({
        role: "execution",
        origin: facadeOrigin,
        inferenceOrigin,
        token: execution.bearer,
        timeoutMs: scenario === "scale-streams" ? 300_000 : scaled ? 180_000 : 25_000,
      });
      const work = (async () => {
        try {
          const payload = body(
            f.runId,
            a.requestId,
            Object.is(scenario, "large-context") ? 1_000_000 : 0,
          );
          a.startedAt = Date.now(); // Actual SDK entry, after provider arming and body construction.
          const response = await client.request(
            execution.executionRef,
            { requestId: a.requestId, admission: execution.admission, body: payload },
            { signal },
          );
          a.response = response.kind;
          if (response.kind === "stream") {
            const claimed = await row(a.requestId);
            check(claimed && captureProof(claimed), "stream-original-claim");
            const chunks: Buffer[] = [];
            for await (const chunk of response.body) {
              a.firstByteAt ??= Date.now();
              a.bytes += chunk.byteLength;
              totalBytes += chunk.byteLength;
              check(
                a.bytes <= bounds.streamBytes && totalBytes <= bounds.totalBytes,
                "consumer-byte-bound",
              );
              chunks.push(Buffer.from(chunk));
            }
            terminal(
              Buffer.concat(chunks),
              scenario === "heavy-output"
                ? "controlled fixture completion" + "x".repeat(262_144)
                : undefined,
            );
            a.validatedStream = true;
          }
        } catch (error) {
          a.response = "error";
          a.error = safeError(error);
          if (error instanceof GatewayError) {
            a.safeCode = error.diagnostic?.code;
          }
          a.preclaimRefused =
            error instanceof GatewayError &&
            error.code === "safe_error" &&
            error.effect === "not_dispatched" &&
            error.diagnostic?.code === "admission_limited";
        }
        a.finishedAt = Date.now();
        return a;
      })();
      pending.add(work);
      void work.finally(() => pending.delete(work));
      return { attempt: a, work, client };
    }
    async function raw(execution: Execution, scenario: Scenario, mode: "held" | "flood") {
      const a = await newAttempt(execution, scenario, "raw-tcp", mode, 0),
        endpoint = new URL(inferenceOrigin);
      const socket = connect({ host: "127.0.0.1", port: Number(endpoint.port) });
      rawSockets.add(socket);
      let first = true,
        header = Buffer.alloc(0),
        ready = false,
        ended = false;
      socket.on("error", () => {
        a.error = "raw-socket-error";
      });
      socket.once("close", () => {
        rawSockets.delete(socket);
        ended = true;
        a.finishedAt = Date.now();
        a.response = "disconnect";
      });
      socket.on("data", (chunk) => {
        try {
          if (first) {
            header = Buffer.concat([header, chunk]);
            check(header.length < 131_072, "raw-header-bound");
            const end = header.indexOf("\r\n\r\n");
            if (end < 0) {
              return;
            }
            const head = header.subarray(0, end).toString("ascii");
            check(
              head.startsWith("HTTP/1.1 200") && head.toLowerCase().includes("text/event-stream"),
              "raw-stream-response",
            );
            a.firstByteAt = Date.now();
            ready = true;
            first = false;
            a.bytes += header.length - end - 4;
            header = Buffer.alloc(0);
            socket.pause();
          } else {
            a.bytes += chunk.length;
          }
          totalBytes += chunk.length;
          check(
            a.bytes <= bounds.streamBytes + 131_072 && totalBytes <= bounds.totalBytes,
            "raw-byte-bound",
          );
        } catch (error) {
          a.error = safeError(error);
          socket.destroy();
        }
      });
      socket.once("connect", () => {
        const payload = body(f.runId, a.requestId);
        a.startedAt = Date.now();
        socket.write(
          "POST /v1/executions/" +
            execution.executionRef +
            "/requests HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer " +
            execution.bearer +
            "\r\nAccept: text/event-stream\r\nContent-Type: application/json\r\nX-Gateway-Request-Id: " +
            a.requestId +
            "\r\nX-Gateway-Admission: " +
            JSON.stringify(execution.admission) +
            "\r\nContent-Length: " +
            payload.length +
            "\r\nConnection: close\r\n\r\n",
        );
        socket.write(payload);
      });
      await until(() => ready || ended, 10_000, "raw-first-byte");
      check(ready, "raw-first-byte");
      const claimed = await row(a.requestId);
      check(claimed && captureProof(claimed), "raw-original-claim");
      return {
        attempt: a,
        socket,
        get ended() {
          return ended;
        },
      };
    }
    try {
      const state = (
        await kernel.query<{ db: string; version: string }>(
          "SELECT current_database() AS db,current_setting('server_version') AS version",
        )
      ).rows[0];
      check(
        state.db === new URL(f.kernelDSN).pathname.slice(1) && /^17\.10(?:$| )/.test(state.version),
        "kernel-pg-identity",
      );
      check(
        (
          await kernel.query(
            "SELECT 1 FROM pg_namespace WHERE nspname IN ('ag_kernel','ag_management')",
          )
        ).rowCount === 0,
        "new-kernel-database",
      );
      const nativeState = (
        await nativeDB.query<{ db: string; version: string }>(
          "SELECT current_database() AS db,current_setting('server_version') AS version",
        )
      ).rows[0];
      check(
        nativeState.db === new URL(f.nativeDSN).pathname.slice(1) &&
          /^17\.10(?:$| )/.test(nativeState.version) &&
          (await nativeDB.query("SELECT 1 FROM public.accounts LIMIT 1")).rowCount === 0,
        "new-migrated-native-database",
      );
      const directory = new URL("../../migrations/", import.meta.url),
        migrationFiles = readdirSync(directory)
          .filter((name) => /^\d{3}_.*\.sql$/.test(name))
          .toSorted();
      check(migrationFiles.length >= 8, "complete-kernel-migration-set");
      for (const name of migrationFiles) {
        await kernel.query(readFileSync(new URL(name, directory), "utf8"));
      }
      const baseURL = await upstream.origin();
      facadeOrigin = await freeOrigin();
      callbackOrigin = await freeOrigin();
      nativeOrigin = await freeOrigin();
      inferenceOrigin = await freeOrigin();
      mkdirSync(join(f.root, "authority"), { mode: 0o700 });
      const profile = {
        profile: profileId,
        model,
        baseURL,
        qualificationRef: "controlled-fullstack-load-v1",
        limits,
        providerTokenUpperBound: 100,
      };
      const config: ServiceConfig = {
        kernelDSN: f.kernelDSN,
        durableFacts: {
          maxServiceFacts: 32768,
          maxConsumerFacts: 16384,
          maxAccountFacts: 2048,
          workerSlots: 2,
          issuerSlots: 3,
        },
        facadeOrigin,
        callbackOrigin,
        native: {
          executable: f.native.executable,
          sha256: f.native.sha256,
          bootstrapFile: join(f.root, "bootstrap.json"),
          authorityDir: join(f.root, "authority"),
          origin: nativeOrigin,
          originRef: "load-" + f.runId,
          uid: 65534,
          gid: 65534,
        },
        consumer,
        profile,
        bearers: [
          {
            role: "management",
            token: managementToken,
            consumerId,
            ownerRefs: [ownerRef],
            preparation: {
              accountRefs: [],
              subjectRef: "load-management",
              policyRevision: 1,
              bindingRevision: 1,
              profileId,
              limits,
              maxRunMs: bounds.wallMs,
            },
          },
          {
            role: "consumer-control",
            token: controlToken,
            consumerId,
            profileIds: [profileId],
            limits,
            maxRunMs: bounds.wallMs,
          },
        ],
        keys: {
          intentAEAD: randomBytes(32).toString("base64"),
          intentHMAC: randomBytes(32).toString("base64"),
          facadeHMAC: randomBytes(32).toString("base64"),
        },
      };
      const nativeConnection = new URL(f.nativeDSN);
      nativeConnection.searchParams.set("sslmode", "disable");
      const bootstrap = {
        listenAddress: new URL(nativeOrigin).host,
        publicListenAddress: new URL(inferenceOrigin).host,
        publicMaxActive,
        postgresDSN: nativeConnection.href,
        authority: { origin: callbackOrigin, credential: consumer.callbackCredential },
        custody: {
          activeKeyId: "load-fixture",
          keys: [{ id: "load-fixture", key: randomBytes(32).toString("base64") }],
        },
        peers: [
          { consumerId, role: "management", credential: consumer.managementCredential },
          { consumerId, role: "execution", credential: consumer.executionCredential },
          { consumerId, role: "cleanup", credential: consumer.cleanupCredential },
        ],
        profile: {
          model,
          baseURL,
          qualificationRef: profile.qualificationRef,
          requestBytes: limits.requestBytes,
          outputBytes: limits.outputBytes,
          tokens: limits.tokens,
          providerTokenUpperBound: profile.providerTokenUpperBound,
        },
        maxEntries: bounds.attempts,
      };
      writeFileSync(join(f.root, "bootstrap.json"), JSON.stringify(bootstrap), {
        mode: 0o600,
        flag: "wx",
      });
      writeFileSync(join(f.root, "service.json"), JSON.stringify(config), {
        mode: 0o600,
        flag: "wx",
      });
      save("source-manifest.json", {
        runId: f.runId,
        seed: f.seed,
        gatewayCommit: f.gatewayCommit,
        gateway: source,
        native: {
          sourceCommit: f.native.sourceCommit,
          sha256: f.native.sha256,
          migrationsSha256: f.native.migrationsSha256,
          migrationFiles: f.native.migrationFiles,
        },
        kernelMigrations: migrationFiles.map((name) => ({
          name,
          sha256: sha256(readFileSync(new URL(name, directory))),
        })),
        sdkArtifact,
        node: process.version,
        network: f.network,
        bounds,
        publicMaxActive,
        profileLimits: limits,
        dataRoute: "public-native-go",
        history: "fresh-reimplementation-no-inherited-receipts",
      });
      service = await startService(join(f.root, "service.json"));
      sampleTimer = setInterval(() => {
        samplingWork = sample().catch(() => {
          setupFailure ??= "resource-observer";
        });
      }, 250);
      management = createManagementClient({
        role: "management",
        origin: facadeOrigin,
        token: managementToken,
        timeoutMs: 10_000,
      });
      control = createConsumerControlClient({
        role: "consumer-control",
        origin: facadeOrigin,
        token: controlToken,
        timeoutMs: 10_000,
      });
      for (
        let i = 0;
        i < (selected.length === 1 && selected[0] === "smoke" ? 1 : bounds.accounts);
        i++
      ) {
        const created = await management.connect({
          operationId: next(),
          ownerRef,
          profileId,
          displayName: "Synthetic load account " + i,
          credential: { kind: "api_key", value: dummy },
        });
        check(created.state === "applied" && created.result?.kind === "account", "account-connect");
        accounts.push(created.result.accountRef);
        executions.push(await prepare(created.result.accountRef));
      }
      check(
        upstream.events.filter((e) => e.event === "entry").length === 0,
        "management-does-not-probe-provider",
      );
      for (const scenario of selected) {
        phase = scenario;
        const began = Date.now(),
          before = attempts.length,
          eventBefore = upstream.events.filter((e) => e.event === "entry").length;
        const details: Record<string, unknown> = {},
          faults: string[] = [];
        let outcome: Outcome = "pass";
        await t.test(
          scenario,
          {
            timeout: Math.min(
              scenario === "scale-streams" ? 600_000 : 180_000,
              bounds.wallMs - (Date.now() - startedAt) - 10_000,
            ),
          },
          async () => {
            try {
              if (scenario === "smoke") {
                for (let i = 0; i < 2; i++) {
                  const run = await launch(executions[0], scenario);
                  await run.work;
                  await drain([run.attempt]);
                }
                requireCompletions(attempts.slice(before), 2);
                details.sameOpenExecution = true;
              } else if (scenario === "short-steps" || scenario === "long-steps") {
                const levels =
                  scenario === "short-steps" ? [1, 2, 4, 8, 16, 24, 32] : [1, 4, 8, 16, 24];
                details.levels = levels;
                details.holdMs = scenario === "short-steps" ? 75 : 1500;
                for (const level of levels) {
                  const runs = await Promise.all(
                    Array.from({ length: level }, (_, index) =>
                      launch(
                        executions[index],
                        scenario,
                        "complete",
                        scenario === "short-steps" ? 75 : 1500,
                      ),
                    ),
                  );
                  await Promise.all(runs.map((r) => r.work));
                  await drain(runs.map((r) => r.attempt));
                  // Six physical data SQL clients plus eight bounded waiters can
                  // safely refuse synchronized preclaims before all16HTTPslotsfill.
                  requireCompletions(
                    runs.map((r) => r.attempt),
                    level <= 8 ? level : 8,
                  );
                  const groups =
                    (details.achieved as
                      | { offered: number; completed: number; safeRefusals: number }[]
                      | undefined) ?? [];
                  groups.push({
                    offered: level,
                    completed: runs.filter((r) => r.attempt.effect === "completed").length,
                    safeRefusals: runs.filter((r) => capacityRefusal(r.attempt)).length,
                  });
                  details.achieved = groups;
                }
              } else if (scenario === "arrivals") {
                details.ratesPerSecond = [1, 4, 8, 16, 32];
                details.secondsPerRate = 2;
                for (const rate of [1, 4, 8, 16, 32]) {
                  const runs: Awaited<ReturnType<typeof launch>>[] = [],
                    arrivalPhase = Date.now();
                  for (let i = 0; i < rate * 2; i++) {
                    const offeredAt = arrivalPhase + Math.floor((i * 1000) / rate);
                    await delay(Math.max(0, offeredAt - Date.now()));
                    runs.push(
                      await launch(
                        executions[i % executions.length],
                        scenario,
                        "complete",
                        250,
                        offeredAt,
                      ),
                    );
                  }
                  await Promise.all(runs.map((r) => r.work));
                  await drain(runs.map((r) => r.attempt));
                  requireCompletions(runs.map((r) => r.attempt));
                }
                await closeAndWait(
                  prepared.filter((p) => executions.some((e) => e.executionRef === p.executionRef)),
                  "post-arrivals-32-executions",
                );
                details.cleanup = cleanupObservations.at(-1);
                executions.length = 0;
                for (const accountRef of accounts) {
                  executions.push(await prepare(accountRef));
                }
                details.freshExecutions = executions.length;
              } else if (scenario === "slow-reader") {
                const execution = await prepare(accounts[0]),
                  run = await raw(execution, scenario, "flood");
                run.attempt.intentionalCancel = "raw-disconnect";
                let blocked: LedgerEvent | undefined,
                  resumed = false;
                try {
                  const deadline = Date.now() + 8000;
                  while (Date.now() < deadline) {
                    const events = upstream.events.filter(
                      (e) => e.requestId === run.attempt.requestId,
                    );
                    const last = events.at(-1);
                    if (last?.event === "blocked" && Date.now() - last.at >= 200) {
                      blocked = last;
                      break;
                    }
                    if (
                      events.some(
                        (e) =>
                          e.event === "budget" || e.event === "close" || e.event === "violation",
                      )
                    ) {
                      break;
                    }
                    await delay(25);
                  }
                  details.pauseMs = Date.now() - run.attempt.firstByteAt!;
                  details.providerStallObserved = !!blocked;
                  run.socket.resume();
                  if (blocked) {
                    await until(
                      () =>
                        upstream.events.some(
                          (e) =>
                            e.requestId === run.attempt.requestId &&
                            e.event === "drain" &&
                            e.sequence > blocked!.sequence,
                        ),
                      5000,
                      "slow-reader-resume-drain",
                    );
                    resumed = true;
                  } else {
                    outcome = "inconclusive";
                    faults.push("upstream-backpressure-not-observed-within-qualified-output-bound");
                  }
                  details.resumeDrainObserved = resumed;
                } finally {
                  run.socket.destroy();
                  await until(() => run.ended, 3000, "slow-reader-socket-close");
                  await drain([run.attempt]);
                }
                check(
                  run.attempt.effect === "effect_unknown",
                  "slow-reader-preserves-unknown-effect",
                );
                check(outcome !== "inconclusive", "slow-reader-backpressure-inconclusive");
              } else if (scenario === "cancellation") {
                const execution = await prepare(accounts[1]),
                  run = await raw(execution, scenario, "held");
                run.attempt.intentionalCancel = "raw-disconnect";
                await until(
                  () => entries(upstream.events, run.attempt.requestId) === 1,
                  3000,
                  "cancel-provider-entry",
                );
                const original = await row(run.attempt.requestId);
                check(original?.transport_occupied === true, "cancel-original-occupied");
                run.socket.destroy();
                await until(() => run.ended, 3000, "raw-disconnect-close");
                await drain([run.attempt]);
                check(
                  run.attempt.effect === "effect_unknown" && run.attempt.providerEntries === 1,
                  "raw-cancel-effect",
                );
                const client = createExecutionClient({
                  role: "execution",
                  origin: facadeOrigin,
                  inferenceOrigin,
                  token: execution.bearer,
                });
                try {
                  const duplicate = await client.request(execution.executionRef, {
                    requestId: run.attempt.requestId,
                    admission: execution.admission,
                    body: body(f.runId, run.attempt.requestId),
                  });
                  check(duplicate.kind === "status", "cancel-duplicate-cannot-stream");
                } catch (error) {
                  check(error instanceof GatewayError, "cancel-duplicate-safe-error");
                }
                await delay(100);
                check(entries(upstream.events, run.attempt.requestId) === 1, "cancel-no-replay");
                details.method = "raw-tcp-destroy-after-real-provider-entry";
                details.duplicateReadbackCannotReplay = true;
                const sdkExecution = await prepare(accounts[2]),
                  abort = new AbortController();
                const sdk = await launch(
                  sdkExecution,
                  scenario,
                  "held",
                  0,
                  Date.now(),
                  abort.signal,
                );
                sdk.attempt.intentionalCancel = "sdk-abort";
                await until(
                  () =>
                    sdk.attempt.firstByteAt !== undefined &&
                    sdk.attempt.firstByteAt !== 0 &&
                    entries(upstream.events, sdk.attempt.requestId) === 1,
                  10_000,
                  "sdk-cancel-first-byte",
                );
                abort.abort();
                await sdk.work;
                await drain([sdk.attempt]);
                check(
                  sdk.attempt.effect === "effect_unknown" && sdk.attempt.providerEntries === 1,
                  "sdk-cancel-effect",
                );
                details.sdkAbortAfterFirstByte = true;
              } else if (scenario === "overload-recovery") {
                const held: Awaited<ReturnType<typeof launch>>[] = [];
                // Distinct, planned requests fill the sixteen real streaming slots
                // after each batch's SQL preflight has settled. No refusal is retried.
                try {
                  for (let index = 0; index < 16; index += 8) {
                    const batch = await Promise.all(
                      executions
                        .slice(index, index + 8)
                        .map((execution) => launch(execution, scenario, "held")),
                    );
                    held.push(...batch);
                    await until(
                      () => batch.every((r) => entries(upstream.events, r.attempt.requestId) === 1),
                      10_000,
                      "planned-held-provider-entries",
                    );
                  }
                  await until(
                    () =>
                      held.filter((r) => entries(upstream.events, r.attempt.requestId) === 1)
                        .length === 16,
                    10_000,
                    "sixteen-real-held-provider-entries",
                  );
                  const controlAt = Date.now();
                  const protectedControl = createConsumerControlClient({
                    role: "consumer-control",
                    origin: callbackOrigin,
                    token: controlToken,
                    timeoutMs: 3000,
                  });
                  const protectedAccount = await protectedControl.get(accounts[0]);
                  check(
                    protectedAccount.accountRef === accounts[0],
                    "protected-control-original-account",
                  );
                  details.controlLatencyMs = Date.now() - controlAt;
                  const overflow = await Promise.all(
                    Array.from({ length: 32 }, (_, i) =>
                      launch(executions[(i + 16) % 32], scenario, "complete"),
                    ),
                  );
                  await Promise.all(overflow.map((r) => r.work));
                  check(
                    overflow.every((r) => entries(upstream.events, r.attempt.requestId) === 0),
                    "overload-no-extra-provider-entry",
                  );
                  check(
                    overflow.some(
                      (r) => r.attempt.response === "error" || r.attempt.response === "status",
                    ),
                    "overload-observed-denials",
                  );
                  details.heldProviderEntries = 16;
                  details.excessAttempts = overflow.length;
                  const closing = held.slice(0, 8);
                  for (const r of closing) {
                    r.attempt.intentionalCancel = "sdk-close";
                  }
                  await closeAndWait(
                    prepared.filter((p) =>
                      executions.slice(0, 8).some((e) => e.executionRef === p.executionRef),
                    ),
                    "eight-sdk-close-under-sixteen-held",
                  );
                  await Promise.all(closing.map((r) => r.work));
                  await drain(closing.map((r) => r.attempt));
                  check(
                    closing.every((r) => r.attempt.effect === "effect_unknown"),
                    "sdk-close-preserves-held-unknown",
                  );
                  details.concurrentSDKCloses = 8;
                  details.closeCleanup = cleanupObservations.at(-1);
                } finally {
                  for (const r of held) {
                    upstream.release(r.attempt.requestId);
                  }
                  await Promise.all(held.map((r) => r.work));
                }
                await drain(attempts.slice(before));
                requireCompletions(
                  held.slice(8).map((r) => r.attempt),
                  8,
                );
                const recovered = await launch(executions[31], scenario);
                await recovered.work;
                await drain([recovered.attempt]);
                check(recovered.attempt.effect === "completed", "overload-fresh-request-recovers");
                details.freshRecovery = true;
              } else if (scenario === "bearer-churn") {
                const beforeEntries = upstream.events.filter((e) => e.event === "entry").length,
                  issued: Execution[] = [];
                for (let i = 0; i < bounds.churnPreparations; i++) {
                  issued.push(await prepare(accounts[i % accounts.length], true));
                }
                check(issued.length === 130 && executionCount > 128, "stateless-bearer-churn");
                const durableExecutions = (
                  await kernel.query<{ n: number }>(
                    "SELECT count(*)::int AS n FROM ag_kernel.executions WHERE consumer=$1",
                    [consumerId],
                  )
                ).rows[0].n;
                check(durableExecutions === executionCount, "churn-exact-durable-executions");
                const original = executions[31],
                  readback = await control.runAccess(original.prepare);
                check(
                  readback.bearer === original.bearer &&
                    readback.operation.state === "applied" &&
                    readback.operation.result?.kind === "execution" &&
                    readback.operation.result.executionRef === original.executionRef,
                  "churn-preserves-original-bearer",
                );
                check(
                  upstream.events.filter((e) => e.event === "entry").length === beforeEntries,
                  "churn-preparation-does-not-dispatch",
                );
                for (let index = 0; index < issued.length; index += 8) {
                  const runs = await Promise.all(
                    issued.slice(index, index + 8).map((execution) => launch(execution, scenario)),
                  );
                  await Promise.all(runs.map((r) => r.work));
                  await drain(runs.map((r) => r.attempt));
                  requireCompletions(
                    runs.map((r) => r.attempt),
                    runs.length,
                  );
                }
                details.configuredBearers = 2;
                details.issuedExecutionBearers = executionCount;
                details.churnPreparations = churnPreparations;
                details.explicitRefusals = 0;
                details.originalBearerPreserved = true;
                details.durableExecutions = durableExecutions;
                details.newBearersExecuted = issued.length;
              } else if (scenario === "scale-streams") {
                const achieved: Record<string, number>[] = [];
                for (const level of [64, 256, 512, 1024]) {
                  const held: Awaited<ReturnType<typeof launch>>[] = [],
                    beganLevel = Date.now();
                  try {
                    // Deliberate admission pacing isolates live-stream capacity.
                    // No rejected paid request is replayed or hidden from the receipt.
                    for (let index = 0; index < level; index += 4) {
                      const batch = await Promise.all(
                        Array.from({ length: Math.min(4, level - index) }, (_, j) =>
                          launch(executions[(index + j) % executions.length], scenario, "held"),
                        ),
                      );
                      held.push(...batch);
                      await until(
                        () =>
                          batch.every(
                            (r) =>
                              r.attempt.firstByteAt !== undefined && r.attempt.firstByteAt !== 0,
                          ),
                        10_000,
                        "scale-stream-admission",
                      );
                    }
                    const occupied = (
                      await kernel.query<{ n: number }>(
                        "SELECT count(*)::int AS n FROM ag_kernel.requests WHERE consumer=$1 AND transport_occupied",
                        [consumerId],
                      )
                    ).rows[0].n;
                    check(
                      occupied === level &&
                        held.every((r) => entries(upstream.events, r.attempt.requestId) === 1),
                      "scale-exact-held-streams",
                    );
                    const controlAt = Date.now();
                    check(
                      (await control.get(accounts[0])).accountRef === accounts[0],
                      "scale-control-progress",
                    );
                    const controlMs = Date.now() - controlAt,
                      holdMs = level === 1024 ? 60_000 : 3000;
                    let maximumControlMs = controlMs;
                    const heldAt = Date.now();
                    do {
                      await delay(Math.min(10_000, Math.max(0, holdMs - (Date.now() - heldAt))));
                      const progressAt = Date.now();
                      check(
                        (await control.get(accounts[0])).accountRef === accounts[0],
                        "scale-held-control-progress",
                      );
                      maximumControlMs = Math.max(maximumControlMs, Date.now() - progressAt);
                      check(
                        (
                          await kernel.query<{ n: number }>(
                            "SELECT count(*)::int AS n FROM ag_kernel.requests WHERE consumer=$1 AND transport_occupied",
                            [consumerId],
                          )
                        ).rows[0].n === level,
                        "scale-held-occupancy",
                      );
                      await sample();
                    } while (Date.now() - heldAt < holdMs);
                    check(
                      held.every(
                        (r) => r.attempt.finishedAt === undefined || r.attempt.finishedAt === 0,
                      ),
                      "scale-streams-remain-open",
                    );
                    const releaseAt = Date.now();
                    // Simultaneous completion exercises bounded settlement queuing.
                    for (const run of held) {
                      upstream.release(run.attempt.requestId);
                    }
                    await Promise.all(held.map((r) => r.work));
                    await drain(held.map((r) => r.attempt));
                    requireCompletions(
                      held.map((r) => r.attempt),
                      level,
                    );
                    achieved.push({
                      streams: level,
                      admissionMs: heldAt - beganLevel,
                      holdMs: releaseAt - heldAt,
                      controlMs,
                      maximumControlMs,
                      completionBurstMs: Date.now() - releaseAt,
                      completed: held.filter((r) => r.attempt.effect === "completed").length,
                    });
                  } finally {
                    for (const run of held) {
                      upstream.release(run.attempt.requestId);
                    }
                    await Promise.all(held.map((r) => r.work));
                  }
                }
                details.achieved = achieved;
                details.publicMaxActive = publicMaxActive;
                details.accountConcurrency = limits.concurrency;
              } else if (scenario === "scale-arrivals" || scenario === "sustained-arrivals") {
                const achieved: Record<string, number>[] = [];
                const sustained = scenario === "sustained-arrivals",
                  controlSamples: number[] = [];
                const steps = sustained
                  ? [{ rate: 50, durationMs: 60_000 }]
                  : [50, 100, 250, 500, 1000].map((rate) => ({ rate, durationMs: 2000 }));
                for (const { rate, durationMs } of steps) {
                  const runs: Promise<Awaited<ReturnType<typeof launch>>>[] = [],
                    start = Date.now();
                  for (let i = 0; i < (rate * durationMs) / 1000; i++) {
                    const offeredAt = start + Math.floor((i * 1000) / rate);
                    await delay(Math.max(0, offeredAt - Date.now()));
                    if (sustained && i > 0 && i % (rate * 10) === 0) {
                      const controlAt = Date.now();
                      check(
                        (await control.get(accounts[0])).accountRef === accounts[0],
                        "sustained-control-progress",
                      );
                      controlSamples.push(Date.now() - controlAt);
                    }
                    runs.push(
                      launch(
                        executions[i % executions.length],
                        scenario,
                        "complete",
                        250,
                        offeredAt,
                      ),
                    );
                  }
                  const started = await Promise.all(runs);
                  await Promise.all(started.map((r) => r.work));
                  await drain(started.map((r) => r.attempt));
                  requireCompletions(started.map((r) => r.attempt));
                  achieved.push(
                    arrivalObservation(
                      started.map((r) => r.attempt),
                      rate,
                      start,
                      Date.now(),
                    ),
                  );
                  if (sustained) {
                    const windows: Record<string, number>[] = [];
                    for (let offset = 0; offset < durationMs; offset += 10_000) {
                      const group = started
                        .slice((rate * offset) / 1000, (rate * (offset + 10_000)) / 1000)
                        .map((r) => r.attempt);
                      requireCompletions(group);
                      // Eventual cohort completion cannot prove continuity: count
                      // successful terminal delivery inside the actual wall interval.
                      const completedDuringWindow = started.filter(
                        ({ attempt: a }) =>
                          a.effect === "completed" &&
                          a.validatedStream === true &&
                          a.finishedAt !== undefined &&
                          a.finishedAt >= start + offset &&
                          a.finishedAt < start + offset + 10_000,
                      ).length;
                      check(completedDuringWindow > 0, "sustained-window-durable-progress");
                      windows.push({
                        windowStartMs: offset,
                        completedDuringWindow,
                        ...arrivalObservation(
                          group,
                          rate,
                          start + offset,
                          Math.max(
                            start + offset + 10_000,
                            ...group.map((a) => a.finishedAt ?? Date.now()),
                          ),
                        ),
                      });
                    }
                    details.windows = windows;
                    details.maximumControlMs = Math.max(0, ...controlSamples);
                    details.controlChecks = controlSamples.length;
                  }
                }
                details.achieved = achieved;
                details.interpretation = sustained
                  ? "one-minute-continuity-with-measured-completions-and-safe-refusals"
                  : "arrival-overload-characterization-not-1000-rps-capacity-claim";
              } else if (Object.is(scenario, "large-context")) {
                const achieved: Record<string, number>[] = [];
                for (const level of [1, 8, 32, 64]) {
                  const start = Date.now(),
                    runs = await Promise.all(
                      Array.from({ length: level }, (_, i) =>
                        launch(executions[i % executions.length], scenario, "complete", 250),
                      ),
                    );
                  await Promise.all(runs.map((r) => r.work));
                  await drain(runs.map((r) => r.attempt));
                  requireCompletions(runs.map((r) => r.attempt));
                  achieved.push({
                    concurrentOffers: level,
                    requestBodyBytes: body(f.runId, runs[0].attempt.requestId, 1_000_000).length,
                    completed: runs.filter((r) => r.attempt.effect === "completed").length,
                    safeRefusals: runs.filter((r) => capacityRefusal(r.attempt)).length,
                    elapsedMs: Date.now() - start,
                  });
                }
                details.achieved = achieved;
                details.interpretation = "large-context-synchronized-offer-characterization";
              } else if (scenario === "heavy-output") {
                // Exercise actual concurrent stream occupancy, not just simultaneous
                // offers. Send 256-KiB delta text before holding the terminal frame.
                const achieved: Record<string, number>[] = [];
                for (const level of [1, 8, 32, 64]) {
                  const held: Awaited<ReturnType<typeof launch>>[] = [],
                    beganLevel = Date.now();
                  try {
                    for (let index = 0; index < level; index += 4) {
                      const batch = await Promise.all(
                        Array.from({ length: Math.min(4, level - index) }, (_, j) =>
                          launch(
                            executions[(index + j) % executions.length],
                            scenario,
                            "heavy-held",
                          ),
                        ),
                      );
                      held.push(...batch);
                      await until(
                        () =>
                          batch.every(
                            (r) =>
                              r.attempt.firstByteAt !== undefined &&
                              entries(upstream.events, r.attempt.requestId) === 1,
                          ),
                        15_000,
                        "heavy-output-admission",
                      );
                    }
                    const occupied = (
                      await kernel.query<{ n: number }>(
                        "SELECT count(*)::int AS n FROM ag_kernel.requests WHERE consumer=$1 AND transport_occupied",
                        [consumerId],
                      )
                    ).rows[0].n;
                    check(occupied === level, "heavy-output-exact-occupancy");
                    const controlAt = Date.now();
                    check(
                      (await control.get(accounts[0])).accountRef === accounts[0],
                      "heavy-output-control-progress",
                    );
                    const controlMs = Date.now() - controlAt,
                      heldAt = Date.now();
                    await delay(3000);
                    check(
                      held.every((r) => r.attempt.finishedAt === undefined) &&
                        (
                          await kernel.query<{ n: number }>(
                            "SELECT count(*)::int AS n FROM ag_kernel.requests WHERE consumer=$1 AND transport_occupied",
                            [consumerId],
                          )
                        ).rows[0].n === level,
                      "heavy-output-remains-occupied",
                    );
                    const releaseAt = Date.now();
                    for (const run of held) {
                      upstream.release(run.attempt.requestId);
                    }
                    await Promise.all(held.map((r) => r.work));
                    await drain(held.map((r) => r.attempt));
                    requireCompletions(
                      held.map((r) => r.attempt),
                      level,
                    );
                    check(
                      held.every(
                        (r) =>
                          r.attempt.bytes > 900_000 &&
                          r.attempt.bytes < bounds.streamBytes &&
                          r.attempt.validatedStream === true,
                      ),
                      "heavy-output-complete-bytes",
                    );
                    achieved.push({
                      streams: level,
                      occupiedDuringHold: occupied,
                      holdMs: releaseAt - heldAt,
                      controlMs,
                      completed: held.filter((r) => r.attempt.effect === "completed").length,
                      minimumCompletedBytes: Math.min(...held.map((r) => r.attempt.bytes)),
                      totalCompletedBytes: held.reduce((n, r) => n + r.attempt.bytes, 0),
                      completionBurstMs: Date.now() - releaseAt,
                      elapsedMs: Date.now() - beganLevel,
                    });
                  } finally {
                    for (const run of held) {
                      upstream.release(run.attempt.requestId);
                    }
                    await Promise.all(held.map((r) => r.work));
                  }
                }
                details.achieved = achieved;
                details.interpretation =
                  "large-SSE-simultaneous-physical-occupancy-and-exact-original-closure-not-model-token-capacity";
              }
              const group = attempts.slice(before);
              await drain(group);
              check(
                !upstream.failed && !upstream.events.some((e) => e.event === "violation"),
                "provider-ledger-valid",
              );
              for (const a of group) {
                faults.push(
                  ...reconcile(a, upstream.events).map((fault) => a.requestId + ":" + fault),
                );
              }
              check(faults.length === 0, "scenario-invariant");
            } catch (error) {
              if (outcome !== "inconclusive") {
                outcome = "fail";
              }
              faults.push(safeError(error));
              throw new Error("load:" + scenario + "-" + outcome, { cause: error });
            } finally {
              results.push({
                scenario,
                outcome,
                startedAt: began,
                finishedAt: Date.now(),
                attempts: attempts.length - before,
                providerEntries:
                  upstream.events.filter((e) => e.event === "entry").length - eventBefore,
                faults,
                details,
              });
              save("attempts.json", attempts);
              save("scenarios.json", results);
            }
          },
        );
      }
    } catch (error) {
      setupFailure = safeError(error);
      if (error instanceof Error) {
        const stage = Object.getOwnPropertyDescriptor(error, "startupStage")?.value as unknown;
        if (
          typeof stage === "string" &&
          ["starting", "ready", "heartbeat", "facade-listen"].includes(stage)
        ) {
          setupDetails.startupStage = stage;
        }
        const cause: unknown = error.cause;
        if (
          cause !== null &&
          typeof cause === "object" &&
          "code" in cause &&
          typeof cause.code === "string" &&
          /^[A-Za-z0-9_]{1,40}$/.test(cause.code)
        ) {
          setupDetails.causeCode = cause.code;
        }
      }
      throw new Error("load:" + setupFailure, { cause: error });
    } finally {
      phase = "drain";
      for (const socket of rawSockets) {
        socket.destroy();
      }
      for (const event of upstream.events) {
        if (event.event === "entry") {
          try {
            upstream.release(event.requestId);
          } catch {
            /* stopped provider */
          }
        }
      }
      await bounded(Promise.allSettled(pending), bounds.drainMs, "final-data-drain").catch(() => {
        setupFailure ??= "final-data-drain";
      });
      if (service) {
        await drain(attempts).catch(() => {
          setupFailure ??= "final-exact-closure-drain";
        });
        if (prepared.length) {
          try {
            await closeAndWait(prepared, "final-all-original-executions");
            terminalCounts = await readTerminalCounts();
            check(
              terminalCounts.open === 0 &&
                terminalCounts.occupied === 0 &&
                terminalCounts.unresolved_cleanup === 0,
              "final-no-open-or-unresolved-work",
            );
            await drain(attempts);
            for (const a of attempts) {
              check(
                reconcile(a, upstream.events).length === 0,
                "final-effects-and-closure-preserved",
              );
            }
          } catch (error) {
            setupFailure ??= "final-durable-cleanup";
            setupDetails.cleanupCode = safeError(error);
            terminalCounts = await readTerminalCounts().catch(() => ({ observerUnavailable: 1 }));
          }
        }
        stopped = await service.stop().catch(() => "stop-failed");
        service = undefined;
      }
      clearInterval(sampleTimer);
      await samplingWork;
      eventLoop.disable();
      await upstream.stop().catch(() => {
        setupFailure ??= "provider-stop";
      });
      await Promise.allSettled([kernel.end(), nativeDB.end()]);
      const ledgerPath = join(f.artifacts, "provider-ledger.ndjson");
      let ledgerMatches = false;
      try {
        const disk = readFileSync(ledgerPath, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as unknown);
        ledgerMatches = JSON.stringify(disk) === JSON.stringify(upstream.events);
      } catch {
        setupFailure ??= "provider-ledger-file";
      }
      const finalSource = sourceManifest(workspace);
      const finalSDKArtifact = sdkArtifactManifest();
      if (finalSource.sha256 !== source.sha256) {
        setupFailure ??= "source-changed-during-run";
      }
      if (finalSDKArtifact.sha256 !== sdkArtifact.sha256) {
        setupFailure ??= "sdk-artifact-changed-during-run";
      }
      save("attempts.json", attempts);
      save(
        "preparations.json",
        prepared.map((p) => ({
          operationId: p.input.operationId,
          invocationRef: p.input.invocationRef,
          attemptRef: p.input.attemptRef,
          accountRefs: p.input.accountRefs,
          subjectRef: p.input.subjectRef,
          executionRef: p.executionRef,
          closeOperationId: p.closeOperationId,
          issued: !!p.execution,
          refused: Boolean(p.refused),
          closed: Boolean(p.closed),
          closeStage: p.closeStage,
          acknowledgementState: p.acknowledgementState,
        })),
      );
      save("resources.json", {
        intervalMs: 250,
        scope: "driver-node-and-exact-live-native-engine-with-read-only-sql",
        samples,
      });
      const artifactBytes = readdirSync(f.artifacts).reduce(
        (n, name) => n + statSync(join(f.artifacts, name)).size,
        0,
      );
      const pass =
        !isNonemptyString(setupFailure) &&
        ledgerMatches &&
        stopped === "retired" &&
        results.length === selected.length &&
        results.every((r) => r.outcome === "pass") &&
        artifactBytes < bounds.artifactBytes - 65_536;
      save("summary.json", {
        kind: "actual-fullstack-load-v1",
        runId: f.runId,
        seed: f.seed,
        outcome: pass ? "pass" : "fail",
        startedAt,
        finishedAt: Date.now(),
        node: process.version,
        sourceSha256: source.sha256,
        sourceUnchanged: finalSource.sha256 === source.sha256,
        sdkArtifactSha256: sdkArtifact.sha256,
        sdkArtifactUnchanged: finalSDKArtifact.sha256 === sdkArtifact.sha256,
        nativeSha256: f.native.sha256,
        scenarios: results,
        expectedScenarios: selected,
        attempts: attempts.length,
        executionBearers: executionCount,
        churnPreparations,
        publicMaxActive,
        profileLimits: limits,
        dataRoute: "public-native-go",
        accounts: accounts.length,
        totalConsumerBytes: totalBytes,
        artifactBytes,
        ledgerMatches,
        stopped,
        setupFailure,
        setupDetails,
        terminalCounts,
        bounds,
        history: "fresh-reimplementation-no-inherited-receipts",
      });
      check(pass, "qualification-incomplete-or-failed");
    }
  },
);
