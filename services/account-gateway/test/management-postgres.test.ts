import test, { before as beforeTests, after as afterTests } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { PostgresKernel } from "../src/postgres.ts";
import { KernelError, defaults } from "../src/domain.ts";
import type {
  TrustedContext,
  AccountIntent,
  OperationStatus,
  CleanupClaim,
  PrivateAdmission,
} from "../src/domain.ts";
import { AccountManagement, exactCandidate, physicalCandidate } from "../src/management.ts";
import type {
  CandidateJournal,
  CandidateScope,
  CandidateMapping,
  CreateInput,
  ManagedProfile,
  NativeReadback,
} from "../src/management.ts";
import { IntentSecrets, PostgresManagementStore } from "../src/management-store.ts";
import { NativeManagementClient } from "../src/native-client.ts";

function redactPostgresSetupFailure(error: unknown): Error {
  if (error instanceof assert.AssertionError) {
    return error;
  }
  return new Error("NOT_RUN: disposable PostgreSQL setup unavailable; vendor details withheld");
}

const constraint = (error: unknown): boolean =>
  error !== null && typeof error === "object" && "code" in error && error.code === "23514";

let pool: Pool,
  lockPool: Pool,
  kernel: PostgresKernel,
  custody: IntentSecrets,
  store: PostgresManagementStore;
const profile = Object.freeze({
  profile: "synthetic-profile",
  baseURL: "https://fixture.invalid/v1",
  model: "fixture-model",
  qualificationRef: "fixture-only",
});
function disposable(): { dsn: string; database: string } {
  const dsn = process.env.AG_MANAGEMENT_TEST_DSN ?? process.env.AG_KERNEL_TEST_DSN,
    database = process.env.AG_MANAGEMENT_DISPOSABLE_DB ?? process.env.AG_KERNEL_DISPOSABLE_DB;
  if (
    dsn === undefined ||
    dsn === "" ||
    database === undefined ||
    database === "" ||
    !/^ag_kernel_test_[a-z0-9_]+$/.test(database) ||
    process.env.AG_KERNEL_TEST_ALLOW !== "disposable_pg17_10"
  ) {
    throw new Error("NOT_RUN: explicit new disposable PG17.10 fixture required");
  }
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new Error("NOT_RUN: invalid disposable designation");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.pathname !== "/" + database ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("NOT_RUN: refusing remote or unspecified DB");
  }
  return { dsn, database };
}
beforeTests(async () => {
  const selected = disposable();
  pool = new Pool({ connectionString: selected.dsn, max: 4, connectionTimeoutMillis: 5000 });
  lockPool = new Pool({ connectionString: selected.dsn, max: 1, connectionTimeoutMillis: 5000 });
  pool.on("error", () => {});
  lockPool.on("error", () => {});
  try {
    const version = (
      await pool.query<{ db: string; version: string }>(
        "SELECT current_database() AS db,current_setting('server_version') AS version",
      )
    ).rows[0];
    assert.equal(version.db, selected.database);
    assert.match(version.version, /^17\.10(?:$| )/);
    const present = await pool.query(
      "SELECT 1 FROM pg_namespace WHERE nspname IN ('ag_kernel','ag_management')",
    );
    assert.equal(present.rowCount, 0, "requires empty disposable DB; never overwrite a schema");
    const directory = new URL("../migrations/", import.meta.url);
    for (const file of (await readdir(directory))
      .filter((f) => /^\d{3}_.*\.sql$/.test(f))
      .toSorted()) {
      await pool.query(await readFile(new URL(file, directory), "utf8"));
    }
    kernel = new PostgresKernel(pool);
    custody = new IntentSecrets(randomBytes(32), randomBytes(32));
    store = new PostgresManagementStore(pool, custody);
  } catch (e) {
    throw redactPostgresSetupFailure(e);
  }
});
afterTests(async () => {
  await Promise.all([pool, lockPool].filter(Boolean).map((p) => p.end()));
});
const ctx = (): TrustedContext => ({ consumerId: "synthetic-" + randomUUID() });
const input = (): CreateInput => ({
  operationId: randomUUID(),
  ownerRef: "workspace-fixture",
  profile: profile.profile,
  displayName: "Disposable fixture",
  apiKey: "fixture-key-" + randomUUID(),
});
const isCode =
  (code: string) =>
  (e: unknown): boolean =>
    e instanceof KernelError && e.code === code;
// Existing private Go candidate and descriptor JSON; fixture performs no provider call.
function nativeBody(d: NativeReadback): object {
  return {
    descriptor: {
      account_id: d.nativeId,
      generation: d.generation,
      created_at: d.createdAt,
      profile: d.profile,
      base_url: d.baseURL,
      model: d.model,
    },
    name: "Disposable fixture",
    state: d.state,
    group_free: true,
    schedulable: false,
    probes_enabled: false,
  };
}
let nextNativeID = 734; // One synthetic engine identity space across disposable HTTP listeners.
async function fixture(
  context: TrustedContext,
  mode:
    | "lost_ack"
    | "wrong"
    | "multiple"
    | "zero"
    | "error"
    | "redirect"
    | "activation_lost_ack"
    | "fraction_above"
    | "fraction_below" = "lost_ack",
) {
  let creates = 0,
    erases = 0,
    providerCalls = 0;
  const bodies: Record<string, unknown>[] = [],
    reads: string[] = [],
    rows = new Map<string, NativeReadback>();
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/provider") === true) {
      providerCalls++;
      res.end("{}");
      return;
    }
    if (req.method === "POST" && req.url === "/private/native/v1/candidates") {
      creates++;
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk as Buffer));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
        bodies.push(body);
        const generation = String(body.generation);
        rows.set(generation, {
          generation,
          nativePhysicalIdentity: generation,
          nativeId: mode.startsWith("fraction_") ? 734 : nextNativeID++,
          createdAt: mode.startsWith("fraction_")
            ? "2026-10-03T07:08:09.987654321+00:00"
            : "2026-10-03T04:05:06.123456789+00:00",
          state: "inactive",
          ...profile,
        });
        req.socket.destroy(); // Native write completed; ACK was lost.
      });
      return;
    }
    const generation = req.url?.split("/")[5] ?? "";
    if (req.method === "GET" && req.url === "/private/native/v1/candidates/" + generation) {
      reads.push(generation);
      if (mode === "error" || mode === "redirect") {
        res.statusCode = mode === "error" ? 401 : 302;
        res.setHeader("location", "/provider");
        res.end("synthetic-private-body");
        return;
      }
      const row = rows.get(generation);
      const candidates =
        !row || mode === "zero"
          ? []
          : mode === "wrong"
            ? [{ ...row, generation: randomUUID(), nativePhysicalIdentity: randomUUID() }]
            : mode === "multiple"
              ? [row, { ...row, nativeId: 999 }]
              : [row];
      let body = JSON.stringify(
        candidates.length === 1 ? nativeBody(candidates[0]) : candidates.map(nativeBody),
      );
      if (mode === "fraction_above" || mode === "fraction_below") {
        body = body.replace(
          '"account_id":734',
          '"account_id":' +
            (mode === "fraction_above" ? "734.000000000000000001" : "733.999999999999999999"),
        );
      }
      res.end(body);
      return;
    }
    if (req.method === "PUT" && req.url === "/private/native/v1/candidates/" + generation) {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk as Buffer));
      req.on("end", () => {
        const change = JSON.parse(Buffer.concat(chunks).toString()) as {
          state: "inactive" | "active";
          descriptor: { generation: string; created_at: string; account_id: number };
        };
        const row = rows.get(generation);
        if (
          !row ||
          change.descriptor.generation !== row.generation ||
          change.descriptor.created_at !== row.createdAt ||
          change.descriptor.account_id !== row.nativeId
        ) {
          res.statusCode = 409;
          res.end();
          return;
        }
        const updated = { ...row, state: change.state };
        rows.set(generation, updated);
        if (mode === "activation_lost_ack" && change.state === "active") {
          req.socket.destroy();
        } else {
          res.end(JSON.stringify(nativeBody(updated)));
        }
      });
      return;
    }
    if (
      req.method === "POST" &&
      req.url === "/private/native/v1/candidates/" + generation + "/erase"
    ) {
      erases++;
      if (rows.get(generation)?.state !== "inactive") {
        res.statusCode = 409;
        res.end();
        return;
      }
      rows.delete(generation);
      res.end(JSON.stringify({ state: "tombstoned", credentials_erased: true }));
      return;
    }
    providerCalls++;
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address();
  assert.ok(addr !== null && typeof addr === "object");
  const native = new NativeManagementClient({
    origin: "http://127.0.0.1:" + addr.port,
    consumerId: context.consumerId,
    controlCredential: "synthetic-control",
  });
  const worker = randomUUID();
  await kernel.heartbeat(context, worker);
  const manager = new AccountManagement({
    kernel,
    store,
    custody,
    native,
    worker,
    profiles: [profile, { ...profile, profile: "second-fixture-profile" }],
    proof: {
      async verify(j, d) {
        return rows.get(j.generation)?.nativeId === d.nativeId;
      },
    },
  });
  return {
    native,
    worker,
    manager,
    rows,
    bodies,
    reads,
    creates: () => creates,
    erases: () => erases,
    providerCalls: () => providerCalls,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
async function staged(
  context: TrustedContext,
  command: CreateInput,
  targetStore = store,
): Promise<{ operation: OperationStatus; scope: CandidateScope }> {
  const intent: AccountIntent = {
    operationId: command.operationId,
    kind: "create",
    ownerRef: command.ownerRef,
    profile: command.profile,
    displayName: command.displayName,
    intentDigest: "",
  };
  intent.intentDigest = custody.digest({ context, intent, apiKey: command.apiKey });
  const operation = await kernel.beginAccount(context, intent);
  assert.ok(typeof operation.accountRef === "string" && operation.accountRef !== "");
  const scope: CandidateScope = {
    consumerId: context.consumerId,
    operationId: command.operationId,
    accountRef: operation.accountRef,
    ownerRef: command.ownerRef!,
    purpose: "create",
  };
  assert.equal(await targetStore.stage(scope, command.apiKey), true);
  return { operation, scope };
}
async function owned(
  context: TrustedContext,
  command: CreateInput,
  worker: string,
): Promise<CandidateJournal> {
  const start = await staged(context, command);
  const permit = await kernel.startCandidate(context, command.operationId, worker);
  assert.ok(permit);
  return store.journal(start.scope, permit.candidate, worker, profile);
}

// Regression: lost native ACK could authorize a second create or promote an unpersisted/lossy physical mapping.
void test("B3a actual HTTP lost ACK persists precise mapping before promotion and restart repeats no POST", async () => {
  const context = ctx(),
    command = input(),
    f = await fixture(context);
  try {
    const result = await f.manager.create(context, command);
    assert.equal(result.state, "applied");
    assert.equal(f.creates(), 1);
    assert.equal(f.reads.length, 2);
    const journal = await store.readJournal(context, command.operationId);
    assert.ok(journal);
    assert.deepEqual(f.reads, [journal.generation, journal.generation]);
    const freshStore = new PostgresManagementStore(pool, custody);
    const mapping = await freshStore.mapping(context, journal.generation);
    assert.ok(mapping);
    assert.equal(mapping.descriptor.nativePhysicalIdentity, journal.generation);
    assert.equal(mapping.descriptor.nativeId, 734);
    assert.equal(mapping.descriptor.createdAt, "2026-10-03T04:05:06.123456789+00:00");
    const restarted = new AccountManagement({
      kernel: new PostgresKernel(pool),
      store: freshStore,
      custody,
      native: f.native,
      worker: f.worker,
      profiles: [profile],
      proof: {
        async verify() {
          return true;
        },
      },
    });
    assert.deepEqual(await restarted.create(context, command), result);
    assert.equal(f.creates(), 1);
    assert.equal(await freshStore.credential(journal), undefined);
    assert.deepEqual(Object.keys(await restarted.account(context, result.accountRef!)).toSorted(), [
      "accountRef",
      "displayName",
      "epoch",
      "ownerRef",
      "profile",
      "revision",
      "state",
    ]);
    assert.equal(
      JSON.stringify(await restarted.operation(context, command.operationId)).includes(
        command.apiKey,
      ),
      false,
    );
    const requestRows = (
      await pool.query<{ n: number }>(
        "SELECT count(*)::integer AS n FROM ag_kernel.requests WHERE consumer=$1",
        [context.consumerId],
      )
    ).rows[0].n;
    assert.equal(requestRows, 0, "management never preclaims an inference request");
  } finally {
    await f.close();
  }
});

// Regression: a crash after sole POST but before readback must recover only its journaled generation, erase intent and avoid recreating.
void test("B3a restart after native write uses persisted generation GET and spent permit", async () => {
  const context = ctx(),
    command = input(),
    f = await fixture(context);
  try {
    const j = await owned(context, command, f.worker);
    await assert.rejects(f.native.create(j, command.displayName!, command.apiKey));
    const restarted = new AccountManagement({
      kernel: new PostgresKernel(pool),
      store: new PostgresManagementStore(pool, custody),
      custody,
      native: f.native,
      worker: f.worker,
      profiles: [profile],
      proof: {
        async verify() {
          return true;
        },
      },
    });
    assert.equal((await restarted.create(context, command)).state, "applied");
    assert.equal(f.creates(), 1);
    assert.deepEqual(f.reads, [j.generation, j.generation]);
    assert.equal(await store.credential(j), undefined);
    assert.ok(await store.mapping(context, j.generation));
    assert.equal(await kernel.startCandidate(context, command.operationId, f.worker), undefined);
    await restarted.create(context, command);
    assert.equal(f.creates(), 1);
  } finally {
    await f.close();
  }
});

// Regression: changed key/name/owner/profile intent reuse must conflict, while original ID+intent survives restart and encrypted staging.
void test("B3a same and changed intent are governed by kernel HMAC without plaintext JSONB", async () => {
  const context = ctx(),
    command = input(),
    f = await fixture(context);
  try {
    const first = await f.manager.create(context, command);
    assert.deepEqual(await f.manager.create(context, { ...command }), first);
    for (const changed of [
      { ...command, apiKey: command.apiKey + "x" },
      { ...command, displayName: "Changed" },
      { ...command, ownerRef: "other-owner" },
      { ...command, profile: "second-fixture-profile" },
    ]) {
      await assert.rejects(f.manager.create(context, changed), isCode("conflict"));
    }
    const pendingCommand = input(),
      pending = await staged(context, pendingCommand);
    const row = (
      await pool.query<{ ciphertext: Buffer | null }>(
        "SELECT * FROM ag_management.transient_intents WHERE consumer=$1 AND operation_id=$2",
        [context.consumerId, pendingCommand.operationId],
      )
    ).rows[0];
    assert.ok(Buffer.isBuffer(row.ciphertext));
    assert.equal(row.ciphertext.includes(Buffer.from(pendingCommand.apiKey)), false);
    assert.equal((await store.credential(pending.scope)) === pendingCommand.apiKey, true);
    const intents = (
      await pool.query<{ intent: unknown }>(
        "SELECT intent FROM ag_kernel.operations WHERE consumer=$1",
        [context.consumerId],
      )
    ).rows;
    assert.equal(JSON.stringify(intents).includes(command.apiKey), false);
    assert.equal(JSON.stringify(intents).includes(pendingCommand.apiKey), false);
    assert.equal(f.creates(), 1);
  } finally {
    await f.close();
  }
});

// Regression: TTL expiry and erase must remove all envelope bytes and must not resurrect credentials or issue a late create.
void test("B3a expired encrypted intents erase, remain nonrenewable and bounded at admission saturation", async () => {
  const context = ctx(),
    command = input();
  const short = new PostgresManagementStore(pool, custody, { ttlMs: 20, maxIntents: 1, batch: 1 });
  const first = await staged(context, command, short);
  await delay(40);
  assert.equal(await short.credential(first.scope), undefined);
  await short.expire(context);
  const row = (
    await pool.query<{ nonce: Buffer | null; ciphertext: Buffer | null; tag: Buffer | null }>(
      "SELECT nonce,ciphertext,tag FROM ag_management.transient_intents WHERE consumer=$1 AND operation_id=$2",
      [context.consumerId, command.operationId],
    )
  ).rows[0];
  assert.deepEqual(row, { nonce: null, ciphertext: null, tag: null });
  assert.equal(await short.stage(first.scope, command.apiKey), false);
  const next = input();
  const intent: AccountIntent = {
    operationId: next.operationId,
    kind: "create",
    intentDigest: "fixture-intent",
    ownerRef: next.ownerRef,
    profile: next.profile,
    displayName: next.displayName,
  };
  const second = await kernel.beginAccount(context, intent);
  assert.ok(typeof second.accountRef === "string" && second.accountRef !== "");
  await assert.rejects(
    short.stage(
      { ...first.scope, operationId: next.operationId, accountRef: second.accountRef },
      next.apiKey,
    ),
    isCode("unavailable"),
  );
  // Exact scope mismatch cannot decrypt or erase another consumer's intent.
  assert.equal(await short.credential({ ...first.scope, ownerRef: "wrong-owner" }), undefined);
});

// Regression: duplicate physical row, altered creation precision, stale model or cross-consumer lookup must never replace immutable mapping.
void test("B3a mapping uniqueness, immutable precision/profile and consumer isolation fail closed", async () => {
  const context = ctx(),
    f = await fixture(context);
  try {
    const one = input();
    await f.manager.create(context, one);
    const j = await store.readJournal(context, one.operationId);
    assert.ok(j);
    const mapping = await store.mapping(context, j.generation);
    assert.ok(mapping);
    await store.saveMapping(mapping); // Exact persisted acknowledgement is idempotent.
    await assert.rejects(
      store.saveMapping({
        ...mapping,
        descriptor: { ...mapping.descriptor, createdAt: "2026-10-03T04:05:06.123456Z" },
      }),
      isCode("conflict"),
    );
    await assert.rejects(
      store.saveMapping({
        ...mapping,
        descriptor: { ...mapping.descriptor, model: "stale-model" },
      }),
      isCode("conflict"),
    );
    const second = await owned(context, input(), f.worker);
    await assert.rejects(
      store.saveMapping({
        ...second,
        descriptor: {
          ...mapping.descriptor,
          generation: second.generation,
          nativePhysicalIdentity: second.generation,
        },
      }),
      isCode("conflict"),
    );
    const other = ctx();
    await kernel.issuer(other);
    assert.equal(await store.mapping(other, j.generation), undefined);
    assert.equal(await store.readJournal(other, one.operationId), undefined);
    const attempt = await pool.query<{ native_created_at: string }>(
      `UPDATE ag_management.physical_mappings SET native_created_at=native_created_at
      WHERE consumer=$1 AND generation=$2 RETURNING native_created_at`,
      [context.consumerId, j.generation],
    );
    assert.equal(attempt.rows[0].native_created_at, "2026-10-03T04:05:06.123456789+00:00");
    await assert.rejects(
      pool.query(
        "UPDATE ag_management.physical_mappings SET native_id=1 WHERE consumer=$1 AND generation=$2",
        [context.consumerId, j.generation],
      ),
      (e: unknown) => e !== null && typeof e === "object" && "code" in e && e.code === "23514",
    );
  } finally {
    await f.close();
  }
});

test("mapping snapshots progress under a held consumer write lock and hide uncommitted mappings", async () => {
  const context = ctx(),
    command = input(),
    f = await fixture(context);
  const gate = await lockPool.connect();
  let pending: Promise<(CandidateMapping | undefined)[]> | undefined;
  let observed: (CandidateMapping | undefined)[] | undefined;
  let committed: CandidateMapping | undefined, fresh: CandidateJournal | undefined;
  try {
    await f.manager.create(context, command);
    const journal = await store.readJournal(context, command.operationId);
    assert.ok(journal);
    committed = await store.mapping(context, journal.generation);
    assert.ok(committed);
    fresh = await owned(context, input(), f.worker);
    await gate.query("BEGIN");
    await gate.query("SELECT 1 FROM ag_kernel.consumers WHERE consumer=$1 FOR UPDATE", [
      context.consumerId,
    ]);
    await gate.query(
      `INSERT INTO ag_management.physical_mappings
      (consumer,generation,native_physical_identity,native_id,native_created_at) VALUES ($1,$2,$2,$3,$4)`,
      [context.consumerId, fresh.generation, nextNativeID++, "2026-10-03T04:05:06.123456789+00:00"],
    );
    pending = Promise.all([
      store.mapping(context, journal.generation),
      store.mapping(context, fresh.generation),
      store.mapping(context, randomUUID()),
    ]);
    observed = await Promise.race([pending, delay(2000).then(() => undefined)]);
    await gate.query("COMMIT");
  } finally {
    await gate.query("ROLLBACK");
    gate.release();
    await pending?.catch(() => undefined);
    await f.close();
  }
  assert.ok(
    observed,
    "read-only mapping snapshots must finish before the consumer writer releases its lock",
  );
  assert.deepEqual(
    observed,
    [committed, undefined, undefined],
    "only committed immutable mappings are visible",
  );
  assert.ok(fresh);
  assert.equal(
    (await store.mapping(context, fresh.generation))?.generation,
    fresh.generation,
    "a later snapshot observes the commit",
  );
  const unknown = ctx();
  await assert.rejects(store.mapping(unknown, fresh.generation), isCode("unknown"));
  assert.equal(
    (await pool.query("SELECT 1 FROM ag_kernel.consumers WHERE consumer=$1", [unknown.consumerId]))
      .rowCount,
    0,
  );
});

// Regression: independently valid FKs can attach custody/journal rows to unrelated parents.
void test("B3a direct SQL inserts bind create/reconnect operation, account, owner, permit worker and profile", async () => {
  for (const purpose of ["create", "reconnect"] as const) {
    const context = ctx(),
      f = await fixture(context);
    try {
      const active = await f.manager.create(context, input());
      const renamed = await kernel.beginAccount(context, {
        operationId: randomUUID(),
        kind: "rename",
        intentDigest: "fixture-rename",
        accountRef: active.accountRef!,
        expectedRevision: active.revision!,
        displayName: "Renamed fixture",
      });
      const other = await kernel.beginAccount(context, {
        operationId: randomUUID(),
        kind: "create",
        intentDigest: "fixture-other",
        ownerRef: "other-fixture-owner",
        profile: "second-fixture-profile",
        displayName: "Other fixture",
      });
      const otherPermit = await kernel.startCandidate(context, other.operationRef, f.worker);
      assert.ok(otherPermit);
      const operationId = randomUUID();
      const operation = await kernel.beginAccount(
        context,
        purpose === "create"
          ? {
              operationId,
              kind: purpose,
              intentDigest: "fixture-create",
              ownerRef: "workspace-fixture",
              profile: profile.profile,
              displayName: "New fixture",
            }
          : {
              operationId,
              kind: purpose,
              intentDigest: "fixture-reconnect",
              accountRef: renamed.accountRef!,
              expectedRevision: renamed.revision!,
            },
      );
      // Read actual kernel parents independently of the production management validation.
      const account = (
        await pool.query<{ owner_ref: string }>(
          "SELECT owner_ref FROM ag_kernel.accounts WHERE consumer=$1 AND ref=$2",
          [context.consumerId, operation.accountRef],
        )
      ).rows[0];
      const candidate = (
        await pool.query<{ generation: string; profile: string }>(
          "SELECT generation,profile FROM ag_kernel.candidates WHERE consumer=$1 AND operation_id=$2",
          [context.consumerId, operationId],
        )
      ).rows[0];
      const scope: CandidateScope = {
        consumerId: context.consumerId,
        operationId,
        accountRef: operation.accountRef!,
        ownerRef: account.owner_ref,
        purpose,
      };
      const envelope = custody.seal(scope, "fixture-parent-scope");
      const transient = async (row: CandidateScope): Promise<void> => {
        await pool.query(
          `INSERT INTO ag_management.transient_intents
          (consumer,operation_id,account_ref,owner_ref,purpose,nonce,ciphertext,tag,created_at,expires_at)
          SELECT $1,$2,$3,$4,$5,$6,$7,$8,t,t+interval '1 minute' FROM (SELECT clock_timestamp() AS t) stamp`,
          [
            row.consumerId,
            row.operationId,
            row.accountRef,
            row.ownerRef,
            row.purpose,
            envelope.nonce,
            envelope.ciphertext,
            envelope.tag,
          ],
        );
      };
      for (const [name, row] of [
        ["account", { ...scope, accountRef: other.accountRef! }],
        ["operation", { ...scope, operationId: other.operationRef }],
        ["rename operation", { ...scope, operationId: renamed.operationRef }],
        ["owner", { ...scope, ownerRef: "wrong-fixture-owner" }],
        ["purpose", { ...scope, purpose: purpose === "create" ? "reconnect" : "create" }],
      ] satisfies [string, CandidateScope][]) {
        await assert.rejects(transient(row), constraint, name);
      }
      await transient(scope);
      assert.equal(await store.credential(scope), "fixture-parent-scope");
      const worker = randomUUID();
      await kernel.heartbeat(context, worker);
      const journal: CandidateJournal = {
        ...scope,
        generation: candidate.generation,
        worker: f.worker,
        profile: { ...profile, profile: candidate.profile },
      };
      const insertJournal = async (row: CandidateJournal): Promise<void> => {
        await pool.query(
          `INSERT INTO ag_management.candidate_journal
          (consumer,operation_id,account_ref,owner_ref,purpose,generation,worker,profile,base_url,model,qualification_ref)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            row.consumerId,
            row.operationId,
            row.accountRef,
            row.ownerRef,
            row.purpose,
            row.generation,
            row.worker,
            row.profile.profile,
            row.profile.baseURL,
            row.profile.model,
            row.profile.qualificationRef,
          ],
        );
      };
      await assert.rejects(insertJournal(journal), constraint, "unconsumed candidate");
      const permit = await kernel.startCandidate(context, operationId, f.worker);
      assert.ok(permit);
      assert.equal(permit.candidate, candidate.generation);
      for (const [name, row] of [
        [
          "candidate/account",
          { ...journal, generation: otherPermit.candidate, accountRef: other.accountRef! },
        ],
        ["operation", { ...journal, operationId: other.operationRef }],
        ["rename operation", { ...journal, operationId: renamed.operationRef }],
        ["owner", { ...journal, ownerRef: "wrong-fixture-owner" }],
        ["purpose", { ...journal, purpose: purpose === "create" ? "reconnect" : "create" }],
        ["worker", { ...journal, worker }],
        ["profile", { ...journal, profile: { ...profile, profile: "second-fixture-profile" } }],
      ] satisfies [string, CandidateJournal][]) {
        await assert.rejects(insertJournal(row), constraint, name);
      }
      assert.equal(await store.readJournal(context, operationId), undefined);
      await insertJournal(journal);
      assert.deepEqual(await store.readJournal(context, operationId), journal);
      await pool.query(
        `INSERT INTO ag_management.physical_mappings
        (consumer,generation,native_physical_identity,native_id,native_created_at) VALUES ($1,$2,$2,$3,$4)`,
        [
          context.consumerId,
          journal.generation,
          purpose === "create" ? 424242 : 424243,
          "2026-10-03T04:05:06.123456789+00:00",
        ],
      );
      const mapping = await store.mapping(context, journal.generation);
      assert.ok(mapping);
      assert.equal(mapping.ownerRef, account.owner_ref);
      assert.equal(mapping.accountRef, operation.accountRef);
      assert.equal(mapping.descriptor.profile, candidate.profile);
      await assert.rejects(
        pool.query(
          "UPDATE ag_management.candidate_journal SET owner_ref=$3 WHERE consumer=$1 AND generation=$2",
          [context.consumerId, journal.generation, "wrong-fixture-owner"],
        ),
        constraint,
      );
      assert.equal(
        (await kernel.unknownCandidate(context, operationId, f.worker)).state,
        "unknown",
      );
      assert.equal(await kernel.startCandidate(context, operationId, f.worker), undefined);
      assert.deepEqual(
        await store.mapping(context, journal.generation),
        mapping,
        "unknown retains immutable mapping history",
      );
      assert.equal(f.providerCalls(), 0);
    } finally {
      await f.close();
    }
  }
});

// Regression: zero/ambiguous/wrong/error/redirect readback must quarantine without a provider call, raw body or second create.
void test("B3a wrong native readback, status and redirect quarantine and do not invoke provider", async () => {
  for (const mode of ["wrong", "multiple", "zero", "error", "redirect"] as const) {
    const context = ctx(),
      command = input(),
      f = await fixture(context, mode);
    try {
      const status = await f.manager.create(context, command);
      assert.equal(status.state, "unknown");
      assert.equal((await f.manager.account(context, status.accountRef!)).state, "quarantined");
      const j = await store.readJournal(context, command.operationId);
      assert.ok(j);
      assert.equal(await store.mapping(context, j.generation), undefined);
      assert.equal(await store.credential(j), undefined);
      assert.equal(JSON.stringify(status).includes("synthetic-private-body"), false);
      assert.deepEqual(await f.manager.create(context, command), status);
      assert.equal(f.creates(), 1);
      assert.equal(f.providerCalls(), 0);
      assert.equal(await f.manager.cleanup(context), "quarantined");
      assert.equal(f.erases(), 0);
    } finally {
      await f.close();
    }
  }
});

// Regression: rounded fractional readback could activate and persist a different native identity.
void test("B3a raw fractional HTTP identities quarantine without mapping, activation or replay", async () => {
  for (const mode of ["fraction_above", "fraction_below"] as const) {
    const context = ctx(),
      command = input(),
      f = await fixture(context, mode);
    try {
      const status = await f.manager.create(context, command);
      assert.equal(status.state, "unknown");
      const j = await store.readJournal(context, command.operationId);
      assert.ok(j);
      assert.equal((await kernel.account(context, j.accountRef)).state, "quarantined");
      assert.equal(await store.mapping(context, j.generation), undefined);
      assert.equal(await store.credential(j), undefined);
      assert.equal(f.rows.get(j.generation)?.state, "inactive");
      assert.deepEqual(f.reads, [j.generation]);
      assert.deepEqual(await f.manager.create(context, command), status);
      assert.equal(f.creates(), 1);
      assert.equal(f.providerCalls(), 0);
    } finally {
      await f.close();
    }
  }
});

// Regression: mutation during an awaited real PG lock could switch consumer, owner, intent or submitted credentials before native create.
void test("B3a accepted primitives snapshot before awaited consumer transaction", async () => {
  const context = ctx(),
    originalConsumer = context.consumerId,
    command = input(),
    original = { ...command },
    f = await fixture(context);
  const blocker = await lockPool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT 1 FROM ag_kernel.consumers WHERE consumer=$1 FOR UPDATE", [
      context.consumerId,
    ]);
    const running = f.manager.create(context, command);
    let blocked = false;
    for (let i = 0; i < 100; i++) {
      const waiters = (
        await blocker.query<{ n: number }>(`SELECT count(*)::integer AS n FROM pg_stat_activity
        WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'`)
      ).rows[0].n;
      if (waiters > 0) {
        blocked = true;
        break;
      }
      await delay(10);
    }
    assert.equal(blocked, true, "must observe real transaction wait before mutation");
    Object.assign(context, { consumerId: "changed-consumer" });
    Object.assign(command, {
      ownerRef: "changed-owner",
      profile: "changed-profile",
      displayName: "Changed",
      apiKey: "fixture-changed",
      operationId: "changed-op",
    });
    await blocker.query("COMMIT");
    const status = await running;
    assert.equal(status.state, "applied");
    assert.equal(f.bodies[0].owner_ref, original.ownerRef);
    assert.equal(f.bodies[0].profile, original.profile);
    assert.equal(f.bodies[0].api_key === original.apiKey, true);
    assert.equal(
      (await kernel.account({ consumerId: originalConsumer }, status.accountRef!)).ownerRef,
      original.ownerRef,
    );
    assert.equal(
      (await kernel.operation({ consumerId: originalConsumer }, original.operationId)).state,
      "applied",
    );
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    await f.close();
  }
});

// Regression: rename could reconnect credentials or advance auth epoch; reconnect/disable could skip kernel epoch/fence semantics.
void test("B3a rename is metadata only; reconnect stages replacement and disable erases only mapped generation", async () => {
  const context = ctx(),
    command = input(),
    f = await fixture(context);
  try {
    const result = await f.manager.create(context, command),
      before = await f.manager.account(context, result.accountRef!);
    await f.manager.rename(context, {
      operationId: randomUUID(),
      accountRef: before.accountRef,
      expectedRevision: before.revision,
      displayName: "Renamed fixture",
    });
    const renamed = await f.manager.account(context, before.accountRef);
    assert.equal(renamed.epoch, before.epoch);
    assert.equal(renamed.revision, before.revision + 1);
    assert.equal(f.creates(), 1);
    await f.manager.reconnect(context, {
      operationId: randomUUID(),
      accountRef: renamed.accountRef,
      expectedRevision: renamed.revision,
      apiKey: "fixture-new" + randomUUID(),
    });
    const connected = await f.manager.account(context, before.accountRef);
    assert.equal(connected.epoch, before.epoch + 1);
    assert.equal(f.creates(), 2);
    assert.equal(await f.manager.cleanup(context), "erased");
    assert.equal(f.erases(), 1);
    await f.manager.disable(context, {
      operationId: randomUUID(),
      accountRef: connected.accountRef,
      expectedRevision: connected.revision,
    });
    assert.equal(
      (await f.manager.account(context, connected.accountRef)).epoch,
      connected.epoch + 1,
    );
    assert.equal(await f.manager.cleanup(context), "erased");
    assert.equal(f.erases(), 2);
    assert.equal(f.providerCalls(), 0);
  } finally {
    await f.close();
  }
});

// Regression: owner loss/restart could promote an expired candidate or guessed cleanup identity; exact readback should only enable fenced cleanup.
void test("B3a expired owner recovery records exact physical identity but cannot promote or recreate", async () => {
  const context = ctx(),
    command = input(),
    f = await fixture(context);
  try {
    const j = await owned(context, command, f.worker);
    await assert.rejects(f.native.create(j, command.displayName!, command.apiKey));
    await pool.query(
      "UPDATE ag_kernel.workers SET lease_until=clock_timestamp()-interval '1 second' WHERE consumer=$1 AND worker=$2",
      [context.consumerId, f.worker],
    );
    const fresh = randomUUID();
    await kernel.heartbeat(context, fresh);
    const recovery = new AccountManagement({
      kernel,
      store,
      custody,
      native: f.native,
      worker: fresh,
      profiles: [profile],
      proof: {
        async verify() {
          return true;
        },
      },
    });
    const status = await recovery.recover(context, command.operationId);
    assert.equal(status.state, "unknown");
    assert.equal((await kernel.account(context, status.accountRef!)).state, "quarantined");
    assert.ok(await store.mapping(context, j.generation));
    assert.equal(f.creates(), 1);
    assert.equal(await recovery.cleanup(context), "erased");
    assert.equal(f.erases(), 1);
  } finally {
    await f.close();
  }
});

// Regression: encrypted DB rows alone cannot establish backup safety if pg_dump serializes plaintext or kernel JSONB retains the submitted key.
void test("B3a actual private schema dump contains encrypted envelope and no submitted plaintext", async () => {
  const context = ctx(),
    command = input();
  await staged(context, command);
  const selected = disposable();
  const result = await new Promise<{ status: number | null; bytes: Buffer }>((resolve, reject) => {
    // DSN is inherited privately, never command line or diagnostic output.
    const child = spawn(
      "pg_dump",
      [
        "--dbname",
        selected.dsn,
        "--no-owner",
        "--no-privileges",
        "--schema=ag_management",
        "--schema=ag_kernel",
      ],
      { env: { ...process.env, PGDATABASE: selected.dsn }, stdio: ["ignore", "pipe", "ignore"] },
    );
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 16_777_216) {
        child.kill();
      } else {
        chunks.push(chunk);
      }
    });
    child.once("error", () => {
      reject(new Error("NOT_RUN: pg_dump unavailable"));
    });
    child.once("close", (status) => {
      resolve({ status, bytes: Buffer.concat(chunks) });
    });
  });
  assert.equal(result.status, 0, "actual dump must finish");
  assert.equal(result.bytes.includes(Buffer.from(command.apiKey)), false);
  assert.equal(result.bytes.includes(Buffer.from("transient_intents")), true);
  assert.equal(result.bytes.includes(Buffer.from("physical_mappings")), true);
});

// Regression: a stale native ID, creation text or model readback must never authorize erasure even when the kernel UUID matches.
void test("B3a cleanup compares the complete mapped descriptor and refuses stale native row", async () => {
  for (const variant of ["id", "createdAt", "model"] as const) {
    const context = ctx(),
      command = input(),
      f = await fixture(context);
    try {
      const operation = await f.manager.create(context, command);
      const account = await f.manager.account(context, operation.accountRef!);
      const j = await store.readJournal(context, command.operationId);
      assert.ok(j);
      const d = f.rows.get(j.generation);
      assert.ok(d);
      f.rows.set(j.generation, {
        ...d,
        ...(variant === "id"
          ? { nativeId: 999 }
          : variant === "createdAt"
            ? { createdAt: "2026-10-03T04:05:06.123456Z" }
            : { model: "stale-model" }),
      });
      await f.manager.disable(context, {
        operationId: randomUUID(),
        accountRef: account.accountRef,
        expectedRevision: account.revision,
      });
      assert.equal(await f.manager.cleanup(context), "quarantined");
      assert.equal(f.erases(), 0);
      assert.equal(f.creates(), 1);
      assert.equal(f.providerCalls(), 0);
    } finally {
      await f.close();
    }
  }
});

// Regression: provider occupancy must block both adapter erase and trusted
// settlement until the exact native closure ACK; all reconnect ages then retire.
void test("B3a held native transport defers complete generation retirement until exact closure", async () => {
  const context = ctx(),
    command = input(),
    f = await fixture(context);
  try {
    const created = await f.manager.create(context, command),
      account = await f.manager.account(context, created.accountRef!);
    const deadline = new Date(Date.now() + 60_000),
      issuer = await kernel.issuer(context);
    const prepared = await kernel.prepare(context, {
      operationId: randomUUID(),
      intentDigest: "synthetic-preparation",
      invocationRef: "synthetic-invocation",
      attemptRef: "synthetic-attempt",
      permittedAccounts: [account.accountRef],
      profile: profile.profile,
      policySubject: "fixture-binding",
      policyRevision: 1,
      bindingRevision: 1,
      issuerEpoch: issuer,
      deadline,
      limits: { requests: 2, concurrency: 1, requestBytes: 4096, outputBytes: 4096, tokens: 32 },
    });
    assert.ok(typeof prepared.executionRef === "string" && prepared.executionRef !== "");
    const claim = await kernel.claim(
      context,
      prepared.executionRef,
      "held-request",
      f.worker,
      {
        executionRef: prepared.executionRef,
        issuerEpoch: issuer,
        invocationRef: "synthetic-invocation",
        attemptRef: "synthetic-attempt",
        accountRef: account.accountRef,
        authorizationEpoch: account.epoch,
        subjectRef: "fixture-binding",
        policyRevision: 1,
        bindingRevision: 1,
        profileId: profile.profile,
        limits: { requests: 2, concurrency: 1, requestBytes: 4096, outputBytes: 4096, tokens: 32 },
        expiresAt: deadline.toISOString(),
      },
      { originRef: "fixture-origin", engineIncarnation: randomUUID(), requestNonce: randomUUID() },
    );
    assert.ok(claim.dispatch);
    await kernel.effect(
      context,
      prepared.executionRef,
      "held-request",
      f.worker,
      "response_started",
    );
    await kernel.effect(context, prepared.executionRef, "held-request", f.worker, "completed");
    // Reconnect retains the original generation as an older cleanup target.
    await f.manager.reconnect(context, {
      operationId: randomUUID(),
      accountRef: account.accountRef,
      expectedRevision: account.revision,
      apiKey: "fixture-key-" + randomUUID(),
    });
    const reconnected = await f.manager.account(context, account.accountRef);
    const disabled = await f.manager.disable(context, {
      operationId: randomUUID(),
      accountRef: account.accountRef,
      expectedRevision: reconnected.revision,
    });
    assert.equal(disabled.state, "applied");

    // Wrong owner/account operation and a missing operation are never positive
    // completed readback. The former is a safe conflict; missing remains unknown.
    const other = input();
    other.ownerRef = "other-workspace-fixture";
    const otherOperation = await f.manager.create(context, other);
    assert.ok(typeof otherOperation.accountRef === "string" && otherOperation.accountRef !== "");
    await assert.rejects(
      f.manager.retirement(context, account.accountRef, otherOperation.operationRef),
      isCode("conflict"),
    );
    await assert.rejects(
      f.manager.retirement(context, account.accountRef, randomUUID()),
      isCode("unknown"),
    );

    const pending = await f.manager.retirement(context, account.accountRef, disabled.operationRef);
    assert.equal(pending.state, "pending");
    assert.equal(pending.inert, false);
    assert.deepEqual(pending.counts, {
      retainedGenerations: 2,
      settledNativeErasureGenerations: 0,
      retainedExecutions: 1,
      openExecutions: 0,
      requests: 1,
      occupiedTransports: 1,
      acknowledgedNativeTransports: 0,
      positiveKernelNonEntryRequests: 0,
      unknownEffects: 0,
    });
    assert.deepEqual(pending.fence, {
      metadataRevision: reconnected.revision + 1,
      authorizationEpoch: reconnected.epoch + 1,
    });

    const jobs: CleanupClaim[] = [];
    for (let i = 0; i < 4; i++) {
      const job = await kernel.claimCleanup(context, f.worker);
      if (!job) {
        break;
      }
      if (job.scope.kind === "generation") {
        jobs.push(job);
      } else {
        assert.equal(await f.manager.cleanupClaim(context, job), "transport_pending");
      }
    }
    assert.equal(jobs.length, 2, "both retained reconnect generations have cleanup work");
    const heldGeneration = jobs.find(
      (j) =>
        j.scope.kind === "generation" &&
        j.scope.generation === claim.dispatch.closure.native.generation,
    );
    const otherGeneration = jobs.find((j) => j !== heldGeneration);
    assert.ok(heldGeneration && otherGeneration);
    await assert.rejects(
      kernel.settleCleanup(
        context,
        heldGeneration.cleanupRef,
        f.worker,
        heldGeneration.token,
        true,
      ),
      isCode("conflict"),
    );
    assert.equal(await f.manager.cleanupClaim(context, heldGeneration), "quarantined");
    assert.equal(f.erases(), 0);
    assert.deepEqual(
      (
        await pool.query<{ transport_occupied: boolean; effect: string }>(
          `SELECT transport_occupied,effect FROM ag_kernel.requests
      WHERE consumer=$1 AND execution_ref=$2 AND id='held-request'`,
          [context.consumerId, prepared.executionRef],
        )
      ).rows[0],
      { transport_occupied: true, effect: "completed" },
    );

    await kernel.acknowledgeTransportClosed(context, f.worker, claim.dispatch.closure);
    const fresh = await kernel.claimCleanup(context, f.worker);
    assert.ok(fresh && fresh.scope.kind === "generation");
    assert.equal(await f.manager.cleanupClaim(context, fresh), "erased");
    assert.equal(await f.manager.cleanupClaim(context, otherGeneration), "erased");
    assert.equal(f.erases(), 2);
    assert.equal(f.providerCalls(), 0);
    const completed = await f.manager.retirement(
      context,
      account.accountRef,
      disabled.operationRef,
    );
    assert.equal(completed.state, "completed");
    assert.equal(completed.inert, true);
    assert.deepEqual(completed.counts, {
      ...pending.counts,
      settledNativeErasureGenerations: 2,
      occupiedTransports: 0,
      acknowledgedNativeTransports: 1,
    });
    assert.equal(
      (await kernel.request(context, prepared.executionRef, "held-request")).effect,
      "completed",
    );
    assert.equal(
      (
        await pool.query<{ n: number }>(
          "SELECT request_count AS n FROM ag_kernel.executions WHERE consumer=$1 AND ref=$2",
          [context.consumerId, prepared.executionRef],
        )
      ).rows[0].n,
      1,
    );

    // Rename grants no dispatch but invalidates the exact completed snapshot.
    await f.manager.rename(context, {
      operationId: randomUUID(),
      accountRef: account.accountRef,
      expectedRevision: completed.account.revision,
      displayName: "Renamed tombstone",
    });
    assert.equal(
      (await f.manager.retirement(context, account.accountRef, disabled.operationRef)).state,
      "rejected",
    );
  } finally {
    await f.close();
  }
});

// Regression: a copied cleanup token after its DB lease expires must not authorize a native credential erase.
void test("policy-use closure fences borrower X while owner O and borrower Y remain live", async () => {
  const context = ctx(),
    command = input(),
    f = await fixture(context);
  const policyKernel = new PostgresKernel(pool, { ...defaults, maxConcurrent: 2 });
  try {
    const created = await f.manager.create(context, command),
      account = await f.manager.account(context, created.accountRef!);
    const issuer = await policyKernel.issuer(context),
      limits = { requests: 2, concurrency: 2, requestBytes: 4096, outputBytes: 4096, tokens: 32 };
    const held = async (subject: string) => {
      const op = await policyKernel.prepare(context, {
        operationId: randomUUID(),
        intentDigest: "controlled-" + subject,
        invocationRef: randomUUID(),
        attemptRef: "borrowed-attempt",
        permittedAccounts: [account.accountRef],
        profile: profile.profile,
        policySubject: subject,
        policyRevision: 1,
        bindingRevision: 1,
        issuerEpoch: issuer,
        deadline: new Date(Date.now() + 60000),
        limits,
      });
      assert.ok(typeof op.executionRef === "string" && op.executionRef !== "");
      const saved = await policyKernel.savedExecution(context, op.executionRef),
        requestId = randomUUID();
      const claim = await policyKernel.claim(
        context,
        op.executionRef,
        requestId,
        f.worker,
        saved.admission,
        {
          originRef: "controlled-native-origin",
          engineIncarnation: randomUUID(),
          requestNonce: randomUUID(),
        },
      );
      assert.ok(claim.dispatch);
      await policyKernel.effect(context, op.executionRef, requestId, f.worker, "response_started");
      return { ref: op.executionRef, requestId, proof: claim.dispatch.closure };
    };
    const x = await held("borrower-X"),
      y = await held("borrower-Y");
    await policyKernel.effect(context, x.ref, x.requestId, f.worker, "effect_unknown");
    const operationId = randomUUID();
    await policyKernel.fence(context, operationId, "borrower-X", 1);
    const pending = await f.manager.policyClosure(context, operationId);
    assert.equal(pending.state, "pending");
    assert.equal(pending.closed, false);
    assert.equal(pending.policySubject, "borrower-X");
    assert.equal(pending.policyRevision, 1);
    assert.deepEqual(pending.counts, {
      retainedExecutions: 1,
      openExecutions: 0,
      requests: 1,
      occupiedTransports: 1,
      acknowledgedNativeTransports: 0,
      positiveKernelNonEntryRequests: 0,
      unknownEffects: 1,
    });
    await assert.rejects(
      f.manager.policyClosure(context, created.operationRef),
      isCode("conflict"),
    );
    await assert.rejects(f.manager.policyClosure(context, randomUUID()), isCode("unknown"));
    const foreign = ctx();
    await policyKernel.issuer(foreign);
    await assert.rejects(f.manager.policyClosure(foreign, operationId), isCode("unknown"));
    // This PG fixture supplies a trusted exact owner ACK. The joint Go fixture
    // separately proves real ContextDone/forward return/body close validation.
    await policyKernel.acknowledgeTransportClosed(context, f.worker, x.proof);
    const completed = await f.manager.policyClosure(context, operationId);
    assert.equal(completed.state, "completed");
    assert.equal(completed.closed, true);
    assert.deepEqual(completed.counts, {
      ...pending.counts,
      occupiedTransports: 0,
      acknowledgedNativeTransports: 1,
    });
    assert.equal(
      (await policyKernel.request(context, x.ref, x.requestId)).effect,
      "effect_unknown",
    );
    assert.equal((await policyKernel.savedExecution(context, y.ref)).state, "open");
    assert.deepEqual(
      (
        await pool.query<{ transport_occupied: boolean; effect: string }>(
          `SELECT effect,transport_occupied FROM ag_kernel.requests WHERE consumer=$1 AND execution_ref=$2 AND id=$3`,
          [context.consumerId, y.ref, y.requestId],
        )
      ).rows[0],
      { effect: "response_started", transport_occupied: true },
    );
    assert.deepEqual(await f.manager.account(context, account.accountRef), account);
    assert.equal(f.erases(), 0);
    assert.equal(f.providerCalls(), 0);
    const emptyOp = randomUUID();
    await policyKernel.fence(context, emptyOp, "no-retained-use", 1);
    const empty = await f.manager.policyClosure(context, emptyOp);
    assert.equal(empty.closed, true);
    assert.equal(empty.counts.retainedExecutions, 0);
    assert.equal(empty.counts.requests, 0);
    await policyKernel.acknowledgeTransportClosed(context, f.worker, y.proof);
  } finally {
    await f.close();
  }
});

void test("B3a expired exact cleanup lease refuses native erasure", async () => {
  const context = ctx(),
    command = input(),
    f = await fixture(context);
  try {
    const status = await f.manager.create(context, command),
      account = await f.manager.account(context, status.accountRef!);
    await f.manager.disable(context, {
      operationId: randomUUID(),
      accountRef: account.accountRef,
      expectedRevision: account.revision,
    });
    const job = await kernel.claimCleanup(context, f.worker);
    assert.ok(job && job.scope.kind === "generation");
    await pool.query(
      "UPDATE ag_kernel.cleanup SET lease_until=clock_timestamp()-interval '1 second' WHERE consumer=$1 AND ref=$2",
      [context.consumerId, job.cleanupRef],
    );
    await assert.rejects(f.manager.cleanupClaim(context, job), isCode("denied"));
    assert.equal(f.erases(), 0);
    assert.equal(f.providerCalls(), 0);
  } finally {
    await f.close();
  }
});

// Regression: a lost native activation ACK could trigger a second create or acknowledge a candidate without exact active-state readback.
void test("B3a lost state activation ACK uses exact GET after persisted staging proof without another create", async () => {
  const context = ctx(),
    command = input(),
    f = await fixture(context, "activation_lost_ack");
  try {
    const result = await f.manager.create(context, command);
    assert.equal(result.state, "applied");
    const j = await store.readJournal(context, command.operationId);
    assert.ok(j);
    assert.ok(await store.mapping(context, j.generation));
    assert.equal(f.rows.get(j.generation)?.state, "active");
    assert.equal(f.creates(), 1);
    assert.deepEqual(f.reads, [j.generation, j.generation]);
    assert.deepEqual(await f.manager.create(context, command), result);
    assert.equal(f.creates(), 1);
    assert.equal(f.providerCalls(), 0);
  } finally {
    await f.close();
  }
});

// Regression: an unexplained active native row could bypass inert staging and be promoted without a persisted controlled-proof mapping.
void test("B3a unexplained already-active candidate quarantines without activation or promotion", async () => {
  const context = ctx(),
    command = input(),
    f = await fixture(context);
  try {
    const j = await owned(context, command, f.worker);
    await assert.rejects(f.native.create(j, command.displayName!, command.apiKey));
    const row = f.rows.get(j.generation);
    assert.ok(row);
    f.rows.set(j.generation, { ...row, state: "active" });
    assert.equal((await f.manager.create(context, command)).state, "unknown");
    assert.equal(await store.mapping(context, j.generation), undefined);
    assert.equal((await kernel.account(context, j.accountRef)).state, "quarantined");
    assert.equal(f.creates(), 1);
    assert.equal(f.providerCalls(), 0);
  } finally {
    await f.close();
  }
});

// Regression: expiry of a journaled create intent could leave ciphertext retained or let a repeated operation consume another create permit.
void test("B3a reconciliation erases expired owned intent and quarantines its spent create", async () => {
  const context = ctx(),
    command = input(),
    f = await fixture(context);
  try {
    const short = new PostgresManagementStore(pool, custody, { ttlMs: 20 });
    const stagedIntent = await staged(context, command, short);
    const permit = await kernel.startCandidate(context, command.operationId, f.worker);
    assert.ok(permit);
    const j = await short.journal(stagedIntent.scope, permit.candidate, f.worker, profile);
    const manager = new AccountManagement({
      kernel,
      store: short,
      custody,
      native: f.native,
      worker: f.worker,
      profiles: [profile],
      proof: {
        async verify() {
          return true;
        },
      },
    });
    await delay(40);
    await manager.reconcile(context);
    assert.equal(await short.credential(j), undefined);
    assert.equal((await kernel.operation(context, command.operationId)).state, "unknown");
    assert.equal((await manager.create(context, command)).state, "unknown");
    assert.equal(f.creates(), 0);
    assert.equal(f.providerCalls(), 0);
  } finally {
    await f.close();
  }
});

const lifecycleProfile: ManagedProfile = Object.freeze({
  profile: "lifecycle-profile",
  baseURL: "https://fixture.invalid/v1",
  model: "lifecycle-model",
  qualificationRef: "fixture-only",
});
const lifecycleIntent = (
  kind: AccountIntent["kind"],
  operationId: string,
  accountRef?: string,
  expectedRevision?: number,
  extra: Partial<AccountIntent> = {},
): AccountIntent =>
  Object.freeze({
    operationId,
    kind,
    intentDigest: randomUUID(),
    accountRef,
    expectedRevision,
    ...extra,
  });
const lifecycleCode =
  (expected: string) =>
  (error: unknown): boolean =>
    error instanceof KernelError && error.code === expected;

interface LifecycleFixture {
  context: TrustedContext;
  worker: string;
  accountRef: string;
  generation: string;
  manager: AccountManagement;
  retention: { failRetained: boolean; beforeProof?: () => Promise<void> };
  erases: number;
}
async function lifecycleActivate(): Promise<LifecycleFixture> {
  const context = ctx(),
    worker = randomUUID();
  await kernel.heartbeat(context, worker);
  const created = await kernel.beginAccount(
    context,
    lifecycleIntent("create", randomUUID(), undefined, undefined, {
      ownerRef: "lifecycle-owner",
      profile: lifecycleProfile.profile,
      displayName: "Lifecycle fixture",
    }),
  );
  assert.equal(created.state, "pending");
  const permit = await kernel.startCandidate(context, created.operationRef, worker);
  assert.ok(permit);
  const scope: CandidateScope = {
    consumerId: context.consumerId,
    operationId: created.operationRef,
    accountRef: created.accountRef!,
    ownerRef: "lifecycle-owner",
    purpose: "create",
  };
  const journal = await store.journal(scope, permit.candidate, worker, lifecycleProfile);
  const mapping: CandidateMapping = Object.freeze({
    ...journal,
    descriptor: physicalCandidate({
      generation: journal.generation,
      nativePhysicalIdentity: journal.generation,
      nativeId: nextNativeID++,
      createdAt: "2026-10-19T00:00:00.000Z",
      ...lifecycleProfile,
    }),
  });
  await store.saveMapping(mapping);
  assert.equal(
    (
      await kernel.acknowledgeCandidate(context, created.operationRef, worker, {
        generation: mapping.generation,
        nativePhysicalIdentity: mapping.descriptor.nativePhysicalIdentity,
        profile: lifecycleProfile.profile,
      })
    ).state,
    "applied",
  );
  const retention: LifecycleFixture["retention"] = { failRetained: false };
  let erases = 0;
  const manager = new AccountManagement({
    kernel,
    store,
    worker,
    profiles: [lifecycleProfile],
    custody,
    native: {
      create: async () => {
        throw new Error("unused");
      },
      read: async () => [],
      setState: async () => {
        throw new Error("unused");
      },
      erase: async () => {
        erases++;
      },
    },
    proof: {
      verify: async (candidate, source) => exactCandidate(candidate, physicalCandidate(source)),
    },
    retainedCustody: {
      verify: async (candidate) => {
        await retention.beforeProof?.();
        return retention.failRetained
          ? undefined
          : {
              contract: "native-retained-custody/v1",
              generation: candidate.generation,
              nativePhysicalIdentity: candidate.descriptor.nativePhysicalIdentity,
              credentialKinds: ["api_key"],
            };
      },
    },
  });
  return {
    context,
    worker,
    accountRef: created.accountRef!,
    generation: permit.candidate,
    manager,
    retention,
    get erases() {
      return erases;
    },
  };
}
async function lifecyclePrepared(
  f: LifecycleFixture,
  operationId: string,
): Promise<{ operation: OperationStatus; admission: PrivateAdmission }> {
  const issuer = await kernel.issuer(f.context);
  const operation = await kernel.prepare(f.context, {
    operationId,
    intentDigest: randomUUID(),
    invocationRef: "invocation-" + operationId,
    attemptRef: "attempt-" + operationId,
    permittedAccounts: [f.accountRef],
    profile: lifecycleProfile.profile,
    policySubject: "policy-" + operationId,
    policyRevision: 1,
    bindingRevision: 1,
    issuerEpoch: issuer,
    deadline: new Date(Date.now() + 60_000),
    limits: { requests: 4, concurrency: 1, requestBytes: 4096, outputBytes: 4096, tokens: 100 },
  });
  assert.equal(operation.state, "applied");
  return {
    operation,
    admission: (await kernel.savedExecution(f.context, operation.executionRef!)).admission,
  };
}

// Regression: suspend must retain the exact native mapping while fencing old
// and new dispatch; only a fresh post-resume epoch can dispatch again.
void test("Gateway lifecycle suspend/resume retains identity and fences old authority", async () => {
  const f = await lifecycleActivate(),
    beforeSuspend = await kernel.account(f.context, f.accountRef);
  const first = await lifecyclePrepared(f, randomUUID());
  const claimed = await kernel.claim(
    f.context,
    first.operation.executionRef!,
    "request-before",
    f.worker,
    first.admission,
    { originRef: "origin-before", engineIncarnation: f.worker, requestNonce: randomUUID() },
  );
  assert.ok(claimed.dispatch);
  const suspended = await f.manager.suspend(f.context, {
    operationId: "suspend-stable",
    accountRef: f.accountRef,
    expectedRevision: beforeSuspend.revision,
  });
  assert.equal(suspended.state, "applied");
  const suspendedAccount = await kernel.account(f.context, f.accountRef);
  assert.equal(suspendedAccount.state, "suspended");
  assert.equal(suspendedAccount.revision, beforeSuspend.revision + 1);
  assert.equal(suspendedAccount.epoch, beforeSuspend.epoch + 1);
  const row = (
    await pool.query<{ state: string; mapped_identity: string; generation_cleanup: string }>(
      `SELECT c.state,m.native_physical_identity AS mapped_identity,
    (SELECT count(*) FROM ag_kernel.cleanup j WHERE j.generation=c.generation) AS generation_cleanup
    FROM ag_kernel.candidates c JOIN ag_management.physical_mappings m ON m.consumer=c.consumer AND m.generation=c.generation
    WHERE c.consumer=$1 AND c.generation=$2`,
      [f.context.consumerId, f.generation],
    )
  ).rows[0];
  assert.equal(row.state, "ready");
  assert.ok(typeof row.mapped_identity === "string" && row.mapped_identity !== "");
  assert.equal(Number(row.generation_cleanup), 0);
  assert.equal(f.erases, 0);

  await assert.rejects(
    kernel.prepare(f.context, {
      operationId: randomUUID(),
      intentDigest: randomUUID(),
      invocationRef: randomUUID(),
      attemptRef: randomUUID(),
      permittedAccounts: [f.accountRef],
      profile: lifecycleProfile.profile,
      policySubject: randomUUID(),
      policyRevision: 1,
      bindingRevision: 1,
      issuerEpoch: first.admission.issuerEpoch,
      deadline: new Date(Date.now() + 60_000),
      limits: first.admission.limits,
    }),
    lifecycleCode("unknown"),
  );
  const deniedClaim = await kernel.claim(
    f.context,
    first.operation.executionRef!,
    "request-after-suspend",
    f.worker,
    first.admission,
    { originRef: "origin-after", engineIncarnation: f.worker, requestNonce: randomUUID() },
  );
  assert.equal(deniedClaim.status.effect, "not_dispatched");
  assert.equal(deniedClaim.status.code, "fenced");
  assert.equal("dispatch" in deniedClaim, false);
  assert.equal(
    (await kernel.savedExecution(f.context, first.operation.executionRef!)).dispatchAllowed,
    false,
  );
  assert.equal(
    (
      await kernel.effect(
        f.context,
        first.operation.executionRef!,
        "request-before",
        f.worker,
        "response_started",
      )
    ).effect,
    "response_started",
  );
  assert.equal(
    (
      await kernel.effect(
        f.context,
        first.operation.executionRef!,
        "request-before",
        f.worker,
        "completed",
      )
    ).effect,
    "completed",
  );

  assert.deepEqual(
    await f.manager.suspend(f.context, {
      operationId: "suspend-stable",
      accountRef: f.accountRef,
      expectedRevision: beforeSuspend.revision,
    }),
    suspended,
  );
  await assert.rejects(
    f.manager.resume(f.context, {
      operationId: "suspend-stable",
      accountRef: f.accountRef,
      expectedRevision: suspendedAccount.revision,
    }),
    lifecycleCode("conflict"),
  );
  await assert.rejects(
    f.manager.resume(f.context, {
      operationId: "resume-wrong-revision",
      accountRef: f.accountRef,
      expectedRevision: suspendedAccount.revision - 1,
    }),
    lifecycleCode("conflict"),
  );
  f.retention.failRetained = true;
  const attention = await f.manager.resume(f.context, {
    operationId: "resume-attention",
    accountRef: f.accountRef,
    expectedRevision: suspendedAccount.revision,
  });
  assert.equal(attention.state, "rejected");
  assert.equal(attention.code, "custody_unavailable");
  assert.equal((await kernel.account(f.context, f.accountRef)).state, "suspended");
  f.retention.failRetained = false;
  const resumed = await f.manager.resume(f.context, {
    operationId: "resume-stable",
    accountRef: f.accountRef,
    expectedRevision: suspendedAccount.revision,
  });
  assert.equal(resumed.state, "applied");
  const active = await kernel.account(f.context, f.accountRef);
  assert.equal(active.state, "active");
  assert.equal(active.revision, suspendedAccount.revision + 1);
  assert.equal(active.epoch, suspendedAccount.epoch + 1);
  const old = await kernel.claim(
    f.context,
    first.operation.executionRef!,
    "old-token-after-resume",
    f.worker,
    first.admission,
    { originRef: "origin-old", engineIncarnation: f.worker, requestNonce: randomUUID() },
  );
  assert.equal(old.status.code, "fenced");
  assert.equal("dispatch" in old, false);
  await kernel.acknowledgeTransportClosed(f.context, f.worker, claimed.dispatch.closure);
  const fresh = await lifecyclePrepared(f, randomUUID());
  assert.ok(
    (
      await kernel.claim(
        f.context,
        fresh.operation.executionRef!,
        "fresh-after-resume",
        f.worker,
        fresh.admission,
        { originRef: "origin-fresh", engineIncarnation: f.worker, requestNonce: randomUUID() },
      )
    ).dispatch,
  );
  assert.equal(f.erases, 0);
});

// Regression: lifecycle and destructive disable serialize on one authority, but
// only disabled fresh credential recovery remains a separate reconnect path.
void test("Gateway lifecycle serializes with disable and keeps fresh reconnect distinct", async () => {
  const f = await lifecycleActivate(),
    account = await kernel.account(f.context, f.accountRef);
  const results = await Promise.allSettled([
    f.manager.suspend(f.context, {
      operationId: randomUUID(),
      accountRef: f.accountRef,
      expectedRevision: account.revision,
    }),
    f.manager.disable(f.context, {
      operationId: randomUUID(),
      accountRef: f.accountRef,
      expectedRevision: account.revision,
    }),
    f.manager.resume(f.context, {
      operationId: randomUUID(),
      accountRef: f.accountRef,
      expectedRevision: account.revision,
    }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.ok(
    ["suspended", "disabled"].includes((await kernel.account(f.context, f.accountRef)).state),
  );

  const disabled = await lifecycleActivate(),
    original = await kernel.account(disabled.context, disabled.accountRef);
  assert.equal(
    (
      await disabled.manager.disable(disabled.context, {
        operationId: "destructive-disable",
        accountRef: disabled.accountRef,
        expectedRevision: original.revision,
      })
    ).state,
    "applied",
  );
  const row = (
    await pool.query<{ state: string; cleanup: string }>(
      `SELECT c.state,(SELECT count(*) FROM ag_kernel.cleanup j
    WHERE j.generation=c.generation) AS cleanup FROM ag_kernel.candidates c
    WHERE c.consumer=$1 AND c.generation=$2`,
      [disabled.context.consumerId, disabled.generation],
    )
  ).rows[0];
  assert.equal(row.state, "quarantined");
  assert.equal(Number(row.cleanup), 1);
  await assert.rejects(
    disabled.manager.resume(disabled.context, {
      operationId: randomUUID(),
      accountRef: disabled.accountRef,
      expectedRevision: original.revision + 1,
    }),
    lifecycleCode("denied"),
  );
  const reconnectIntent = lifecycleIntent(
    "reconnect",
    "fresh-reconnect",
    disabled.accountRef,
    original.revision + 1,
  );
  await assert.rejects(
    kernel.beginAccount(disabled.context, reconnectIntent),
    lifecycleCode("denied"),
  );
  const cleanup = await kernel.claimCleanup(disabled.context, disabled.worker);
  assert.ok(cleanup);
  assert.equal(cleanup.scope.kind, "generation");
  await kernel.settleCleanup(
    disabled.context,
    cleanup.cleanupRef,
    disabled.worker,
    cleanup.token,
    true,
  );
  const reconnect = await kernel.beginAccount(disabled.context, reconnectIntent);
  assert.equal(reconnect.state, "pending");
  assert.equal(reconnect.accountRef, disabled.accountRef);
});

// A valid but delayed native attestation must never undo retirement committed
// while the HTTP read was outstanding.
void test("delayed retained custody cannot resurrect a concurrently retired account", async () => {
  const f = await lifecycleActivate(),
    original = await kernel.account(f.context, f.accountRef);
  await f.manager.suspend(f.context, {
    operationId: randomUUID(),
    accountRef: f.accountRef,
    expectedRevision: original.revision,
  });
  const suspended = await kernel.account(f.context, f.accountRef);
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.retention.beforeProof = async () => {
    entered();
    await held;
  };
  const resume = f.manager.resume(f.context, {
    operationId: randomUUID(),
    accountRef: f.accountRef,
    expectedRevision: suspended.revision,
  });
  await waiting;
  await f.manager.disable(f.context, {
    operationId: randomUUID(),
    accountRef: f.accountRef,
    expectedRevision: suspended.revision,
  });
  release();
  await assert.rejects(resume, lifecycleCode("conflict"));
  assert.equal((await kernel.account(f.context, f.accountRef)).state, "disabled");
});

// Cleanup admission is itself a deny, even before physical erasure settles.
void test("retained custody cannot resume a generation already admitted to erasure", async () => {
  const f = await lifecycleActivate(),
    account = await kernel.account(f.context, f.accountRef);
  await f.manager.suspend(f.context, {
    operationId: randomUUID(),
    accountRef: f.accountRef,
    expectedRevision: account.revision,
  });
  const suspended = await kernel.account(f.context, f.accountRef);
  await pool.query("INSERT INTO ag_kernel.cleanup(consumer,generation) VALUES ($1,$2)", [
    f.context.consumerId,
    f.generation,
  ]);
  const result = await f.manager.resume(f.context, {
    operationId: randomUUID(),
    accountRef: f.accountRef,
    expectedRevision: suspended.revision,
  });
  assert.equal(result.state, "rejected");
  assert.equal(result.code, "custody_unavailable");
  assert.equal((await kernel.account(f.context, f.accountRef)).state, "suspended");
  assert.equal(
    await kernel.claimCleanup(f.context, f.worker),
    undefined,
    "suspended current generation is retained",
  );
  const token = randomUUID();
  const job = (
    await pool.query<{ ref: string }>(
      `UPDATE ag_kernel.cleanup SET state='claimed',worker=$3,token=$4,
    lease_until=clock_timestamp()+interval '1 minute' WHERE consumer=$1 AND generation=$2 RETURNING ref`,
      [f.context.consumerId, f.generation, f.worker, token],
    )
  ).rows[0];
  const mapping = await store.mapping(f.context, f.generation);
  assert.ok(mapping);
  assert.equal(
    await store.cleanupAllowed(
      f.context,
      job.ref,
      f.worker,
      token,
      f.generation,
      mapping.descriptor.nativePhysicalIdentity,
      lifecycleProfile.profile,
    ),
    false,
  );
  await assert.rejects(
    kernel.settleCleanup(f.context, job.ref, f.worker, token, true),
    lifecycleCode("conflict"),
  );
});
