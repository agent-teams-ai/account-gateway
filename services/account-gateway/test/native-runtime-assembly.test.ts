// Controlled joint contract proof only: actual Go + Node + migrated PostgreSQL.
// No SDK/CLI/tools/final/parser/App qualification and no live provider traffic.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { createServer as createTLSServer } from "node:https";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import pg from "pg";
import { createManagementClient, GatewayError } from "@agent-teams/account-gateway/http";
import { PostgresKernel } from "../src/postgres.ts";
import { KernelError } from "../src/domain.ts";
import type { CleanupClaim } from "../src/domain.ts";
import { AccountManagement, exactCandidate, sameCandidate } from "../src/management.ts";
import { IntentSecrets, PostgresManagementStore } from "../src/management-store.ts";
import { NativeManagementClient } from "../src/native-client.ts";
import { NativeAuthority } from "../src/native-authority.ts";
import { NativeHTTPTransport } from "../src/native-transport.ts";
import { createFacade, FacadeBearers } from "../src/facade.ts";
import { descriptor, instant, physicallyClosed, receipt } from "../src/native-wire.ts";

const installation = "/opt/account-gateway-assembly";
const image = installation + "/gateway-assembly-fixture";
const consumerId = "native-assembly-consumer",
  ownerRef = "native-assembly-owner";
const originRef = "native-assembly-origin",
  qualificationRef = "controlled-native-assembly-v1";
const profileId = "openai-responses-apikey-v1",
  model = "mimo-test";
const limits = { requests: 2, concurrency: 1, requestBytes: 4096, outputBytes: 65536, tokens: 32 };
const token = () => randomBytes(32).toString("base64url");
class FixtureFailure extends Error {}
const fail = (phase: string): never => {
  throw new FixtureFailure("assembly fixture: " + phase);
};

// Only safe phase names reach diagnostics. Never attach an upstream/SQL/child
// error, control JSON, PEM, credential, prompt or output as an assertion value.
async function bounded<T>(work: Promise<T>, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new FixtureFailure("assembly fixture: " + phase + " timeout")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function protectedPath(path: string, directory = false): Promise<void> {
  const ancestors: string[] = [];
  for (let p = dirname(path); ; p = dirname(p)) {
    ancestors.push(p);
    if (p === "/") break;
  }
  for (const p of ancestors.reverse()) {
    const s = await lstat(p);
    if (!s.isDirectory() || s.uid !== 0 || (s.mode & 0o022) !== 0) fail("unprotected ancestor");
  }
  const s = await lstat(path);
  if (
    s.uid !== 0 ||
    (s.mode & 0o022) !== 0 ||
    (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1)
  )
    fail("unprotected fixture");
}
function dsn(name: string, prefix: string): string {
  const raw = process.env[name];
  if (!raw) return fail("NOT_RUN missing " + name);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return fail("invalid disposable designation");
  }
  if (
    !["postgres:", "postgresql:"].includes(u.protocol) ||
    u.host !== "127.0.0.1:5432" ||
    u.username !== "postgres" ||
    u.password ||
    u.hash ||
    u.search !== "?sslmode=disable" ||
    !new RegExp("^/" + prefix + "[a-z0-9_]{1,32}$").test(u.pathname)
  )
    fail("refusing non-fixture PostgreSQL");
  return raw;
}
async function listen(server: Server): Promise<number> {
  await bounded(
    new Promise<void>((resolve, reject) => {
      server.once("error", () => reject(new FixtureFailure("assembly fixture: listener")));
      server.listen(0, "127.0.0.1", resolve);
    }),
    "listen",
  );
  const a = server.address();
  if (!a || typeof a === "string") return fail("listener address");
  return a.port;
}
async function stop(server: Server): Promise<void> {
  server.closeAllConnections();
  if (server.listening)
    await bounded(new Promise<void>((resolve) => server.close(() => resolve())), "listener stop");
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail("invalid fixture frame");
  return value as Record<string, unknown>;
}
interface Binding {
  originRef: string;
  bootId: string;
  incarnation: string;
  pid: number;
  birthTicks: string;
  lockDevice: string;
  lockInode: string;
}
function binding(value: unknown): Binding {
  const b = object(value),
    uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  if (
    Object.keys(b).sort().join(",") !==
      "birthTicks,bootId,incarnation,lockDevice,lockInode,originRef,pid" ||
    b.originRef !== originRef ||
    typeof b.bootId !== "string" ||
    !uuid.test(b.bootId) ||
    typeof b.incarnation !== "string" ||
    !uuid.test(b.incarnation) ||
    !Number.isSafeInteger(b.pid) ||
    (b.pid as number) < 1 ||
    ["birthTicks", "lockDevice", "lockInode"].some(
      (k) => typeof b[k] !== "string" || !/^[1-9][0-9]*$/.test(b[k] as string),
    )
  )
    fail("invalid actual launcher binding");
  return b as unknown as Binding;
}
function launch(root: string) {
  // No ambient secrets, PATH, CLI or provider environment inherited by parent.
  const child = spawn(image, ["parent", root], { env: {}, stdio: ["pipe", "pipe", "ignore"] });
  child.stdin.on("error", () => undefined);
  let pulse: ReturnType<typeof setInterval> | undefined,
    stopped = false;
  const exited = new Promise<number | null>((resolve) => {
    child.once("error", () => {
      clearInterval(pulse);
      resolve(-1);
    });
    child.once("close", (code) => {
      clearInterval(pulse);
      resolve(code);
    });
  });
  let size = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    size += chunk.length;
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })[
    Symbol.asyncIterator
  ]();
  const next = async (expected: string) => {
    const line = await bounded(lines.next(), "native " + expected);
    if (line.done || size > 16384 || line.value.length > 8192) return fail("native control stream");
    let m: Record<string, unknown>;
    try {
      m = object(JSON.parse(line.value) as unknown);
    } catch {
      return fail("native control frame");
    }
    if (m.event === "failed")
      return fail(
        "native " +
          (typeof m.phase === "string" && /^[a-z-]+$/.test(m.phase) ? m.phase : "failure"),
      );
    if (m.event !== expected) return fail("native event order");
    // The actual helper expires an idle parent after five seconds. Keep its
    // bounded command wait live during management and the two sequential calls.
    if (expected === "ready" && !stopped) {
      pulse = setInterval(() => child.stdin.write('{"command":"pulse"}\n'), 2000);
      pulse.unref();
    }
    return m;
  };
  return {
    next,
    exited,
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(pulse);
      child.stdin.end('{"command":"stop"}\n');
    },
  };
}

async function migrateKernel(pool: pg.Pool, database: string): Promise<void> {
  const r = (
    await pool.query(`SELECT current_database() AS db,current_setting('server_version') AS version,
    NOT EXISTS (SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace)
    AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace)
    AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typnamespace='public'::regnamespace) AS empty`)
  ).rows[0] as Record<string, unknown>;
  assert.ok(
    r.db === database &&
      typeof r.version === "string" &&
      /^17\.10(?:$| )/.test(r.version) &&
      r.empty === true,
    "new empty PG17.10 kernel database required",
  );
  assert.equal(
    (await pool.query("SELECT 1 FROM pg_namespace WHERE nspname IN ('ag_kernel','ag_management')"))
      .rowCount,
    0,
  );
  const directory = new URL("../migrations/", import.meta.url);
  const files = (await readdir(directory)).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
  assert.equal(files.length, 6, "use the selected complete numbered kernel migration set");
  for (const file of files) await pool.query(await readFile(new URL(file, directory), "utf8"));
}

function completed(bytes: Buffer, expected: string): void {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assert.ok(text.endsWith("\n\n") || text.endsWith("\r\n\r\n"), "SSE must end on a complete frame");
  const events = text
    .replaceAll("\r\n", "\n")
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => {
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data || data === "[DONE]") return undefined;
      try {
        return object(JSON.parse(data) as unknown);
      } catch {
        return fail("invalid native Responses SSE");
      }
    })
    .filter((e) => e !== undefined);
  const terminal = events.filter((e) => e.type === "response.completed");
  assert.equal(terminal.length, 1, "one actual Responses completion event required");
  assert.ok(
    !events.some((e) =>
      ["error", "response.failed", "response.incomplete"].includes(e.type as string),
    ),
    "no native Responses stream error",
  );
  const response = object(terminal[0].response);
  assert.ok(
    response.status === "completed" && Array.isArray(response.output),
    "completed Responses output required",
  );
  const content = response.output
    .flatMap((item: unknown) => {
      const m = object(item);
      return m.type === "message" && Array.isArray(m.content) ? m.content : [];
    })
    .filter((part: unknown) => object(part).type === "output_text")
    .map((part: unknown) => object(part).text)
    .join("");
  assert.ok(
    content === expected && response.model === model,
    "actual native terminal content/model must match controlled completion",
  );
  const deltas = events
    .filter((e) => e.type === "response.output_text.delta")
    .map((e) => e.delta)
    .join("");
  assert.ok(deltas === expected, "actual Responses text delta must reach the facade");
  const usage = object(response.usage);
  assert.ok(
    usage.input_tokens === 3 &&
      usage.output_tokens === 2 &&
      usage.total_tokens === 5 &&
      object(usage.output_tokens_details).reasoning_tokens === 0,
    "actual native Responses must preserve complete usage",
  );
}

test(
  "controlled actual Go/Node/PG: management birth, held retirement, positive closure, SAME OPEN concurrency1",
  { timeout: 45000 },
  async () => {
    if (
      process.env.AG_ASSEMBLY_ALLOW !== "disposable_root_pg17_10" ||
      process.platform !== "linux" ||
      process.getuid?.() !== 0 ||
      !["v26.11.1", "v24.21.0"].includes(process.version)
    )
      fail("NOT_RUN pinned disposable root Linux runner required");
    const kernelDSN = dsn("AG_ASSEMBLY_KERNEL_DSN", "ag_kernel_test_assembly_");
    const nativeDSN = dsn("AG_ASSEMBLY_NATIVE_DSN", "native_bootstrap_assembly_");
    for (const path of [
      image,
      installation + "/tls/ca.pem",
      installation + "/tls/server.pem",
      installation + "/tls/server-key.pem",
    ])
      await protectedPath(path);
    assert.equal((await lstat(installation + "/tls/server-key.pem")).mode & 0o777, 0o600);
    await protectedPath("/root", true);
    const root = "/root/native_bootstrap_assembly_" + randomUUID().replaceAll("-", "");
    await mkdir(root, { mode: 0o700 });
    await mkdir(join(root, "authority"), { mode: 0o700 });
    const kernelPool = new pg.Pool({
      connectionString: kernelDSN,
      max: 4,
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
    });
    const nativePool = new pg.Pool({
      connectionString: nativeDSN,
      max: 2,
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
    });
    kernelPool.on("error", () => undefined);
    nativePool.on("error", () => undefined);
    const servers: Server[] = [];
    let parent: ReturnType<typeof launch> | undefined,
      retired = false,
      upstreamCalls = 0,
      upstreamInvalid = false;
    let callbackHandler: Server | undefined, install: (() => void) | undefined;
    const installed = new Promise<void>((resolve) => {
      install = resolve;
    });
    let holdRetirementACK = false,
      releaseRetirementACK: (() => void) | undefined;
    const retirementACK = new Promise<void>((resolve) => {
      releaseRetirementACK = resolve;
    });
    const callbacks = { enrollment: 0, admit: 0, closureAck: 0 };
    try {
      await migrateKernel(kernelPool, new URL(kernelDSN).pathname.slice(1));
      const credentials = {
        management: token(),
        executionCredential: token(),
        cleanupCredential: token(),
        callbackCredential: token(),
      };
      const dummyKey = "dummy-assembly-only-" + token();
      const upstream = createTLSServer(
        {
          cert: await readFile(installation + "/tls/server.pem"),
          key: await readFile(installation + "/tls/server-key.pem"),
          maxHeaderSize: 16384,
          headersTimeout: 5000,
          requestTimeout: 5000,
          keepAliveTimeout: 1000,
          connectionsCheckingInterval: 100,
        },
        (req, res) => {
          upstreamCalls++;
          const entry = upstreamCalls;
          void (async () => {
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of req) {
              const b = Buffer.from(chunk as Uint8Array);
              size += b.length;
              if (size > 4096) fail("upstream request bound");
              chunks.push(b);
            }
            const body = object(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
            if (
              entry > 3 ||
              req.method !== "POST" ||
              req.url !== "/v1/responses" ||
              req.headers.authorization !== "Bearer " + dummyKey ||
              body.model !== model ||
              body.stream !== true ||
              body.store !== false ||
              Object.hasOwn(body, "service_tier") ||
              req.headers["x-openai-internal-codex-responses-lite"] !== "true" ||
              body.max_output_tokens !== limits.tokens ||
              Object.hasOwn(body, "previous_response_id") ||
              !Array.isArray(body.input) ||
              body.input.length !== 1 ||
              object(body.input[0]).role !== "user" ||
              object(body.input[0]).content !== "assembly question " + entry
            )
              fail("controlled native Responses request");
            res.writeHead(200, {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
            });
            const text = "assembly completion " + entry,
              itemId = "msg_assembly_" + entry;
            const part = { type: "output_text", text, annotations: [], logprobs: [] };
            const item = {
              id: itemId,
              type: "message",
              status: "completed",
              role: "assistant",
              content: [part],
            };
            const response = {
              id: "resp_assembly_" + entry,
              object: "response",
              created_at: 1700000000,
              status: "completed",
              model,
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
            let sequence = 0;
            const frame = (type: string, fields: Record<string, unknown>) =>
              "event: " +
              type +
              "\ndata: " +
              JSON.stringify({ type, sequence_number: sequence++, ...fields }) +
              "\n\n";
            const pending = { ...response, status: "in_progress", output: [], usage: null };
            res.write(frame("response.created", { response: pending }));
            // Keep the third real Go upstream stream open until client cancellation.
            if (entry === 3) return;
            res.write(frame("response.in_progress", { response: pending }));
            res.write(
              frame("response.output_item.added", {
                output_index: 0,
                item: { ...item, status: "in_progress", content: [] },
              }),
            );
            res.write(
              frame("response.content_part.added", {
                item_id: itemId,
                output_index: 0,
                content_index: 0,
                part: { ...part, text: "" },
              }),
            );
            res.write(
              frame("response.output_text.delta", {
                item_id: itemId,
                output_index: 0,
                content_index: 0,
                delta: text,
                logprobs: [],
              }),
            );
            res.write(
              frame("response.output_text.done", {
                item_id: itemId,
                output_index: 0,
                content_index: 0,
                text,
                logprobs: [],
              }),
            );
            res.write(
              frame("response.content_part.done", {
                item_id: itemId,
                output_index: 0,
                content_index: 0,
                part,
              }),
            );
            res.write(frame("response.output_item.done", { output_index: 0, item }));
            res.end(frame("response.completed", { response }));
          })().catch(() => {
            upstreamInvalid = true;
            if (!res.headersSent) res.writeHead(500);
            res.end();
          });
        },
      );
      servers.push(upstream);
      const baseURL = "https://127.0.0.1:" + (await listen(upstream)) + "/v1";
      const callback = createServer(
        {
          maxHeaderSize: 16384,
          headersTimeout: 5000,
          requestTimeout: 5000,
          keepAliveTimeout: 1000,
          connectionsCheckingInterval: 100,
        },
        (req, res) => {
          const timer = setTimeout(() => {
            req.destroy();
            res.destroy();
          }, 5000);
          res.once("close", () => clearTimeout(timer));
          res.once("finish", () => clearTimeout(timer));
          const route = req.url;
          res.once("finish", () => {
            if (res.statusCode === 200) {
              if (route === "/private/native/v1/enrollment") callbacks.enrollment++;
              if (route === "/private/native/v1/admit") callbacks.admit++;
              if (route === "/private/native/v1/closure-ack") callbacks.closureAck++;
            }
          });
          // Go enrolls after G but before R. Wait for the ACTUAL Start binding,
          // then hand the untouched request to the production authority handler.
          void bounded(installed, "binding installation")
            .then(async () => {
              // Model a delayed durable ACK using the actual native HTTP request.
              // No receipt is invented; the original authority validates it afterward.
              if (route === "/private/native/v1/closure-ack" && holdRetirementACK)
                await bounded(retirementACK, "retirement ACK release");
              if (!callbackHandler) return fail("authority installation");
              callbackHandler.emit("request", req, res);
            })
            .catch(() => {
              if (!res.headersSent) res.writeHead(503);
              res.end();
            });
        },
      );
      callback.maxConnections = 8;
      callback.maxRequestsPerSocket = 1;
      callback.on("clientError", (_error, socket) =>
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"),
      );
      servers.push(callback);
      const callbackOrigin = "http://127.0.0.1:" + (await listen(callback));
      const reservation = createServer();
      const nativePort = await listen(reservation);
      await stop(reservation);
      const nativeOrigin = "http://127.0.0.1:" + nativePort;
      const config = {
        listenAddress: "127.0.0.1:" + nativePort,
        postgresDSN: nativeDSN,
        authority: { origin: callbackOrigin, credential: credentials.callbackCredential },
        custody: {
          activeKeyId: "assembly",
          keys: [{ id: "assembly", key: randomBytes(32).toString("base64") }],
        },
        peers: [
          { consumerId, role: "management", credential: credentials.management },
          { consumerId, role: "execution", credential: credentials.executionCredential },
          { consumerId, role: "cleanup", credential: credentials.cleanupCredential },
        ],
        profile: {
          model,
          baseURL,
          qualificationRef,
          requestBytes: limits.requestBytes,
          outputBytes: limits.outputBytes,
          tokens: limits.tokens,
          providerTokenUpperBound: 100,
        },
        maxEntries: 4,
      };
      const file = await open(
        join(root, "bootstrap.json"),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.writeFile(JSON.stringify(config));
        await file.sync();
      } finally {
        await file.close();
      }
      parent = launch(root);
      await parent.next("migrated");
      const actualBinding = binding((await parent.next("binding")).binding);
      const context = Object.freeze({ consumerId }),
        worker = randomUUID();
      const kernel = new PostgresKernel(kernelPool),
        custody = new IntentSecrets(randomBytes(32), randomBytes(32));
      const store = new PostgresManagementStore(kernelPool, custody);
      const profile = { profile: profileId, baseURL, model, qualificationRef };
      const authority = new NativeAuthority({
        kernel,
        store,
        config: {
          origin: nativeOrigin,
          enrollment: {
            originRef: actualBinding.originRef,
            engineIncarnation: actualBinding.incarnation,
            worker,
            qualificationRef,
          },
          consumers: [
            {
              consumerId,
              executionCredential: credentials.executionCredential,
              cleanupCredential: credentials.cleanupCredential,
              callbackCredential: credentials.callbackCredential,
            },
          ],
          profiles: [
            {
              ...profile,
              requestBytes: limits.requestBytes,
              outputBytes: limits.outputBytes,
              tokens: limits.tokens,
              providerTokenUpperBound: 100,
            },
          ],
          timeoutMs: 5000,
          closureWaitMs: 1000,
          maxPending: 8,
        },
      });
      callbackHandler = authority.createServer();
      install!();
      const ready = binding((await parent.next("ready")).binding);
      assert.ok(
        JSON.stringify(ready) === JSON.stringify(actualBinding),
        "readiness must use original actual binding",
      );
      assert.equal(callbacks.enrollment, 1);
      assert.equal(upstreamCalls, 0);
      assert.equal(
        (
          await nativePool.query(`SELECT filename FROM public.schema_migrations
      WHERE filename IN ('241_gateway_native_identity.sql','242_gateway_native_credential_custody.sql')`)
        ).rowCount,
        2,
        "actual complete native migration runner must include identity and encrypted custody",
      );
      await kernel.heartbeat(context, worker);
      const native = new NativeManagementClient({
        origin: nativeOrigin,
        consumerId,
        controlCredential: credentials.management,
      });
      let stagingProofs = 0;
      const management = new AccountManagement({
        kernel,
        store,
        custody,
        native,
        worker,
        profiles: [profile],
        proof: {
          async verify(journal, descriptor) {
            // Actual inert HTTP readback + actual encrypted SQL row + qualified
            // controlled endpoint/profile. No unconditional proof or manual mapping.
            const read = await native.read(journal);
            const row = (
              await nativePool.query(
                `SELECT id::text AS id,
          to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS birth,
          status, schedulable, NOT (extra ?| ARRAY['upstream_billing_probe_enabled','upstream_billing_rate_sync_enabled']) AS probes_off, extra->>'gateway_profile_v1' AS profile,
          credentials->>'base_url' AS base_url, extra->>'gateway_model_v1' AS model,
          public.gateway_native_envelope_valid(credentials->'api_key') AS encrypted,
          strpos(credentials::text,$2)=0 AS secret_free,
          extra->'gateway_credential_scope_v1'=jsonb_build_object('consumer',$3::text,'owner',$4::text,
            'account',$5::text,'generation',$1::text,'purpose','provider-authorization-v1') AS scope_matches,
          NOT EXISTS(SELECT 1 FROM public.account_groups g WHERE g.account_id=a.id) AS group_free
          FROM public.accounts a WHERE extra->>'gateway_generation_v1'=$1`,
                [journal.generation, dummyKey, consumerId, ownerRef, journal.accountRef],
              )
            ).rows;
            const r = row[0] as Record<string, unknown> | undefined;
            const valid =
              exactCandidate(journal, descriptor) &&
              journal.consumerId === consumerId &&
              journal.ownerRef === ownerRef &&
              journal.profile.qualificationRef === qualificationRef &&
              journal.profile.profile === profileId &&
              read.length === 1 &&
              read[0].state === "inactive" &&
              sameCandidate(read[0], descriptor) &&
              row.length === 1 &&
              r !== undefined &&
              r.id === String(descriptor.nativeId) &&
              instant(r.birth) === instant(descriptor.createdAt) &&
              r.status === "disabled" &&
              r.schedulable === false &&
              r.probes_off === true &&
              r.profile === profileId &&
              r.base_url === baseURL &&
              r.model === model &&
              r.encrypted === true &&
              r.secret_free === true &&
              r.scope_matches === true &&
              r.group_free === true &&
              upstreamCalls === 0;
            if (valid) stagingProofs++;
            return valid;
          },
        },
      });
      const operationId = randomUUID();
      const created = await management.create(context, {
        operationId,
        ownerRef,
        profile: profileId,
        displayName: "Controlled assembly",
        apiKey: dummyKey,
      });
      assert.ok(
        created.state === "applied" && created.accountRef,
        "actual management.create must promote the native MiMo Responses profile",
      );
      assert.equal(stagingProofs, 1);
      assert.equal(upstreamCalls, 0);
      const journal = await store.readJournal(context, operationId);
      assert.ok(journal);
      assert.ok(
        (await store.credential(journal)) === undefined,
        "write-only staged credential must be erased",
      );
      const mapping = await store.mapping(context, journal.generation);
      assert.ok(mapping);
      const nativeRead = await native.read(journal);
      assert.ok(
        nativeRead.length === 1 &&
          nativeRead[0].state === "active" &&
          sameCandidate(nativeRead[0], mapping.descriptor),
        "mapping must read actual promoted native birth",
      );
      const account = await kernel.account(context, created.accountRef!);
      assert.equal(account.state, "active");
      const prepared = await kernel.prepare(context, {
        operationId: randomUUID(),
        intentDigest: token(),
        invocationRef: randomUUID(),
        attemptRef: "assembly-attempt",
        permittedAccounts: [account.accountRef],
        profile: profileId,
        policySubject: "assembly-binding",
        policyRevision: 2,
        bindingRevision: 3,
        issuerEpoch: await kernel.issuer(context),
        deadline: new Date(Date.now() + 30000),
        limits,
      });
      assert.ok(prepared.executionRef);
      const saved = await kernel.savedExecution(context, prepared.executionRef);
      const bearer = token();
      const bearers = new FacadeBearers([{ role: "execution", consumerId, token: bearer, saved }]);
      const facade = createFacade({
        kernel,
        management,
        store,
        transport: new NativeHTTPTransport(authority),
        enrollment: authority.configuration.enrollment,
        bearers,
        profiles: [
          {
            dto: {
              profileId,
              protocol: "openai-responses",
              modelIds: [model],
              authKinds: ["api_key"],
            },
            maxOutputTokens: 100,
          },
        ],
        intentHmacKey: randomBytes(32),
        timeoutMs: 5000,
      });
      servers.push(facade);
      const origin = "http://127.0.0.1:" + (await listen(facade));
      const { executionRef: _ref, issuerEpoch: _issuer, ...publicAdmission } = saved.admission;
      for (let i = 1; i <= 2; i++) {
        await kernel.heartbeat(context, worker);
        const requestId = randomUUID();
        const response = await fetch(
          origin + "/v1/executions/" + saved.admission.executionRef + "/requests",
          {
            method: "POST",
            headers: {
              authorization: "Bearer " + bearer,
              "content-type": "application/json",
              accept: "text/event-stream",
              "x-gateway-request-id": requestId,
              "x-gateway-admission": JSON.stringify(publicAdmission),
            },
            body: JSON.stringify({
              model,
              stream: true,
              store: false,
              service_tier: "default",
              max_output_tokens: 32,
              input: [{ role: "user", content: "assembly question " + i }],
            }),
            signal: AbortSignal.timeout(5000),
          },
        );
        assert.equal(
          response.status,
          200,
          "controlled upstream calls=" +
            upstreamCalls +
            " invalid=" +
            upstreamInvalid +
            " native admits=" +
            callbacks.admit,
        );
        const bytes = Buffer.from(await bounded(response.arrayBuffer(), "Responses stream"));
        assert.ok(bytes.length <= limits.outputBytes);
        completed(bytes, "assembly completion " + i);
        assert.equal(upstreamInvalid, false);
        assert.equal(upstreamCalls, i);
        assert.equal(callbacks.admit, i);
        assert.equal(callbacks.closureAck, i);
        const proof = await kernel.requestProof(context, saved.admission.executionRef, requestId);
        assert.ok(proof);
        assert.ok(
          proof.native.originRef === actualBinding.originRef &&
            proof.native.engineIncarnation === actualBinding.incarnation &&
            proof.native.generation === mapping.generation,
          "sole SQL proof must bind actual launcher incarnation and native birth",
        );
        const read = await fetch(nativeOrigin + "/private/native/v1/transports/read-owner", {
          method: "POST",
          headers: {
            authorization: "Bearer " + credentials.executionCredential,
            "content-type": "application/json",
          },
          body: JSON.stringify({ proof }),
          signal: AbortSignal.timeout(5000),
        });
        assert.equal(read.status, 202);
        const closed = receipt((await read.json()) as unknown, consumerId, proof);
        assert.ok(
          physicallyClosed(closed) &&
            closed.acknowledged &&
            closed.lifetime.entered &&
            closed.lifetime.completed,
          "authenticated positive native physical closure and durable ACK required",
        );
        const rows = (
          await kernelPool.query(
            `SELECT effect,transport_occupied FROM ag_kernel.requests
        WHERE consumer=$1 AND execution_ref=$2 AND id=$3`,
            [consumerId, saved.admission.executionRef, requestId],
          )
        ).rows;
        assert.ok(
          rows.length === 1 &&
            rows[0].effect === "completed" &&
            rows[0].transport_occupied === false,
          "one completed SQL claim with released local occupancy",
        );
        const execution = (
          await kernelPool.query(
            "SELECT state,request_count FROM ag_kernel.executions WHERE consumer=$1 AND ref=$2",
            [consumerId, saved.admission.executionRef],
          )
        ).rows[0];
        assert.ok(
          execution.state === "open" && execution.request_count === i,
          "SAME execution stays OPEN with permanently spent claims",
        );
      }
      const proofRows = (
        await kernelPool.query(
          `SELECT request_nonce FROM ag_kernel.requests WHERE consumer=$1 AND execution_ref=$2`,
          [consumerId, saved.admission.executionRef],
        )
      ).rows;
      assert.equal(proofRows.length, 2);
      assert.equal(new Set(proofRows.map((r) => r.request_nonce)).size, 2);
      // ONE real wrong-role request at the private Go execution boundary.
      const deniedResponse = await fetch(nativeOrigin + "/private/native/v1/transports", {
        method: "POST",
        headers: {
          authorization: "Bearer " + credentials.management,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          requestRef: randomUUID(),
          worker,
          admission: saved.admission,
          descriptor: descriptor(mapping.descriptor),
          payload: {
            model,
            stream: true,
            store: false,
            service_tier: "default",
            max_output_tokens: 32,
            input: "assembly role denial",
          },
        }),
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(deniedResponse.status, 403);
      await deniedResponse.body?.cancel();
      assert.equal(upstreamCalls, 2);
      assert.equal(callbacks.admit, 2);
      assert.equal(callbacks.closureAck, 2);
      assert.equal(
        (
          await kernelPool.query(
            "SELECT count(*)::int AS n FROM ag_kernel.requests WHERE consumer=$1",
            [consumerId],
          )
        ).rows[0].n,
        2,
      );
      assert.ok(
        (
          await nativePool.query(
            `SELECT count(*)::int AS n, bool_and(public.gateway_native_envelope_valid(credentials->'api_key')
      AND strpos(credentials::text,$1)=0 AND NOT schedulable AND NOT (extra ?| ARRAY['upstream_billing_probe_enabled','upstream_billing_rate_sync_enabled'])
      AND NOT EXISTS(SELECT 1 FROM public.account_groups g WHERE g.account_id=a.id)) AS safe FROM public.accounts a`,
            [dummyKey],
          )
        ).rows[0].safe === true,
        "actual native ciphertext and group-free inert scheduling survive both requests",
      );
      assert.equal(
        (await nativePool.query("SELECT count(*)::int AS n FROM public.accounts")).rows[0].n,
        1,
      );

      // One accepted held stream exercises the actual erasure/closure boundary.
      const heldPreparation = await kernel.prepare(context, {
        operationId: randomUUID(),
        intentDigest: token(),
        invocationRef: randomUUID(),
        attemptRef: "retirement-attempt",
        permittedAccounts: [account.accountRef],
        profile: profileId,
        policySubject: "assembly-binding",
        policyRevision: 2,
        bindingRevision: 3,
        issuerEpoch: await kernel.issuer(context),
        deadline: new Date(Date.now() + 30000),
        limits,
      });
      assert.ok(heldPreparation.executionRef);
      const heldSaved = await kernel.savedExecution(context, heldPreparation.executionRef);
      const heldBearer = token(),
        controlBearer = token(),
        foreignBearer = token();
      const preparation = {
        accountRefs: [account.accountRef],
        subjectRef: "assembly-binding",
        policyRevision: 2,
        bindingRevision: 3,
        profileId,
        limits,
        maxRunMs: 30000,
      };
      bearers.replace([
        { role: "execution", consumerId, token: bearer, saved },
        { role: "execution", consumerId, token: heldBearer, saved: heldSaved },
        {
          role: "management",
          consumerId,
          token: controlBearer,
          ownerRefs: [ownerRef],
          preparation,
        },
        {
          role: "management",
          consumerId,
          token: foreignBearer,
          ownerRefs: ["foreign-fixture-owner"],
          preparation: { ...preparation, subjectRef: "foreign-fixture-binding" },
        },
      ]);
      const control = createManagementClient({
        role: "management",
        origin,
        token: controlBearer,
        timeoutMs: 5000,
      });
      const foreign = createManagementClient({
        role: "management",
        origin,
        token: foreignBearer,
        timeoutMs: 5000,
      });
      const {
        executionRef: _heldRef,
        issuerEpoch: _heldIssuer,
        ...heldAdmission
      } = heldSaved.admission;
      const heldId = randomUUID();
      holdRetirementACK = true;
      const heldResponse = await fetch(
        origin + "/v1/executions/" + heldSaved.admission.executionRef + "/requests",
        {
          method: "POST",
          headers: {
            authorization: "Bearer " + heldBearer,
            "content-type": "application/json",
            accept: "text/event-stream",
            "x-gateway-request-id": heldId,
            "x-gateway-admission": JSON.stringify(heldAdmission),
          },
          body: JSON.stringify({
            model,
            stream: true,
            store: false,
            service_tier: "default",
            max_output_tokens: 32,
            input: [{ role: "user", content: "assembly question 3" }],
          }),
          signal: AbortSignal.timeout(5000),
        },
      );
      assert.equal(heldResponse.status, 200);
      assert.ok(heldResponse.body);
      const heldReader = heldResponse.body.getReader();
      assert.ok((await bounded(heldReader.read(), "held first frame")).value?.byteLength);
      const fenceId = randomUUID();
      assert.equal(
        (await control.fence({ operationId: fenceId, subjectRef: "assembly-binding", revision: 2 }))
          .state,
        "applied",
      );
      assert.equal((await control.policyClosure(fenceId)).state, "pending");
      await assert.rejects(
        foreign.policyClosure(fenceId),
        (error) => error instanceof GatewayError && error.diagnostic?.code === "forbidden",
      );
      const disableId = randomUUID();
      assert.equal(
        (
          await control.disable(account.accountRef, {
            operationId: disableId,
            expectedMetadataRevision: account.revision,
          })
        ).state,
        "applied",
      );
      const pendingRetirement = await control.retirement(account.accountRef, disableId);
      assert.equal(pendingRetirement.state, "pending");
      assert.equal(pendingRetirement.counts.occupiedTransports, 1);
      await assert.rejects(
        foreign.retirement(account.accountRef, disableId),
        (error) => error instanceof GatewayError && error.diagnostic?.code === "forbidden",
      );
      let generationCleanup: CleanupClaim | undefined;
      for (let i = 0; i < 3; i++) {
        const job = await kernel.claimCleanup(context, worker);
        if (job?.scope.kind === "generation") generationCleanup = job;
      }
      assert.ok(generationCleanup);
      await assert.rejects(
        kernel.settleCleanup(
          context,
          generationCleanup.cleanupRef,
          worker,
          generationCleanup.token,
          true,
        ),
        (error) => error instanceof KernelError && error.code === "conflict",
      );
      assert.equal(await management.cleanupClaim(context, generationCleanup), "quarantined");
      assert.ok(
        (
          await nativePool.query(
            `SELECT deleted_at IS NULL AND public.gateway_native_envelope_valid(credentials->'api_key') AS retained
      FROM public.accounts WHERE extra->>'gateway_generation_v1'=$1`,
            [journal.generation],
          )
        ).rows[0].retained === true,
        "real native credential remains before durable closure ACK",
      );
      await heldReader.cancel();
      releaseRetirementACK!();
      const heldProof = await kernel.requestProof(
        context,
        heldSaved.admission.executionRef,
        heldId,
      );
      assert.ok(heldProof);
      let closed = false;
      for (let i = 0; i < 50 && !closed; i++) {
        const response = await fetch(nativeOrigin + "/private/native/v1/transports/read-owner", {
          method: "POST",
          headers: {
            authorization: "Bearer " + credentials.executionCredential,
            "content-type": "application/json",
          },
          body: JSON.stringify({ proof: heldProof }),
          signal: AbortSignal.timeout(5000),
        });
        assert.equal(response.status, 202);
        const actual = receipt((await response.json()) as unknown, consumerId, heldProof);
        closed = physicallyClosed(actual) && actual.acknowledged;
        if (!closed) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(
        closed,
        true,
        "actual native ContextDone/forward return/body close and ACK required",
      );
      const closedPolicy = await control.policyClosure(fenceId);
      assert.equal(closedPolicy.state, "completed");
      assert.equal(closedPolicy.closed, true);
      assert.equal(closedPolicy.counts.acknowledgedNativeTransports, 3);
      assert.equal(closedPolicy.counts.unknownEffects, 1);
      const freshCleanup = await kernel.claimCleanup(context, worker);
      assert.ok(freshCleanup?.scope.kind === "generation");
      assert.equal(await management.cleanupClaim(context, freshCleanup), "erased");
      const retiredAccount = await control.retirement(account.accountRef, disableId);
      assert.equal(retiredAccount.state, "completed");
      assert.equal(retiredAccount.inert, true);
      assert.equal(retiredAccount.counts.acknowledgedNativeTransports, 3);
      assert.equal(retiredAccount.counts.unknownEffects, 1);
      assert.equal(retiredAccount.counts.settledNativeErasureGenerations, 1);
      assert.ok(
        (
          await nativePool.query(
            `SELECT deleted_at IS NOT NULL AND NOT (credentials ? 'api_key') AS erased
      FROM public.accounts WHERE extra->>'gateway_generation_v1'=$1`,
            [journal.generation],
          )
        ).rows[0].erased === true,
        "normal native erase leaves exact inert birth",
      );
      const heldStatus = await kernel.request(context, heldSaved.admission.executionRef, heldId);
      assert.equal(heldStatus.effect, "effect_unknown");
      assert.equal(
        (
          await kernelPool.query(
            "SELECT request_count FROM ag_kernel.executions WHERE consumer=$1 AND ref=$2",
            [consumerId, heldSaved.admission.executionRef],
          )
        ).rows[0].request_count,
        1,
      );
      assert.equal(upstreamCalls, 3);
      assert.equal(upstreamInvalid, false);
      parent.stop();
      const retirement = await parent.next("retired");
      const teardown = object(retirement.receipt);
      assert.ok(
        JSON.stringify(binding(retirement.binding)) === JSON.stringify(actualBinding) &&
          retirement.receipt !== undefined,
        "actual durable retirement/readback must match complete original binding",
      );
      assert.ok(
        JSON.stringify(binding(teardown.binding)) === JSON.stringify(actualBinding) &&
          teardown.scope === "exact-local-process-transport-teardown-v1" &&
          teardown.method === "observed-child-exit",
        "actual receipt must attest exact child teardown under the launcher scope",
      );
      assert.equal(await bounded(parent.exited, "parent exit"), 0);
      retired = true;
    } catch (error) {
      if (error instanceof assert.AssertionError || error instanceof FixtureFailure) throw error;
      fail("controlled joint contract failed");
    } finally {
      releaseRetirementACK?.();
      parent?.stop();
      if (parent && !retired) await bounded(parent.exited, "failed fixture exit");
      for (const server of servers.reverse()) await stop(server);
      await bounded(Promise.all([kernelPool.end(), nativePool.end()]), "SQL shutdown");
      if (retired) await rm(root, { recursive: true }); // Failed authority evidence survives until primary disposes the runner.
    }
  },
);
