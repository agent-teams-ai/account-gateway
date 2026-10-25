// Explicit qualification only: a real Go HTTP fixture owns native custody;
// this process owns a NEW loopback Gateway PG fixture and never infers/refreshes.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import type { Server } from "node:http";
import pg from "pg";
import * as c from "@agent-teams/account-gateway/contracts";
import { createLifecycleClient } from "@agent-teams/account-gateway/http";
import { KernelError, identifier, uuid } from "../src/domain.ts";
import { PostgresKernel } from "../src/postgres.ts";
import { IntentSecrets, PostgresManagementStore } from "../src/management-store.ts";
import { physicalCandidate, codexOAuthProfile } from "../src/management.ts";
import type { PhysicalCandidate } from "../src/management.ts";
import { composeServiceControl, composeServiceNative } from "../src/service.ts";
import { createFacade } from "../src/facade.ts";
import { strictJSON } from "../src/facade-ingress.ts";

interface FixtureAccount {
  authKind: "api_key" | "oauth";
  operationId: string;
  ownerRef: string;
  accountRef: string;
  qualificationRef: string;
  descriptor: PhysicalCandidate;
}
interface Fixture {
  consumerId: string;
  nativeOrigin: string;
  accounts: FixtureAccount[];
}
let phase = "input",
  kind = "none";
let diagnostic: Record<string, string | number> | undefined;
let pool: pg.Pool | undefined;
const servers: Server[] = [];
const report = (value: object): void => {
  process.stdout.write(JSON.stringify(value) + "\n");
};
const limits = { requests: 4, concurrency: 1, requestBytes: 4096, outputBytes: 4096, tokens: 100 };
const token = (name: string): string => {
  const value = process.env[name];
  assert.ok(value && /^joined-test-[A-Za-z0-9._~-]{8,128}$/.test(value));
  return value;
};
function loopback(value: string): URL {
  const url = new URL(value);
  assert.equal(url.protocol, "http:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.ok(
    url.port && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/",
  );
  return url;
}
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return "http://127.0.0.1:" + address.port;
}
async function continueAfterReady(): Promise<void> {
  const lines = createInterface({ input: process.stdin });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new KernelError("unavailable"));
      }, 30_000);
      lines.once("line", (line) => {
        clearTimeout(timer);
        try {
          assert.ok(line.length <= 128);
          assert.deepEqual(strictJSON(Buffer.from(line)), { phase: "continue" });
          resolve();
        } catch {
          reject(new KernelError("invalid"));
        }
      });
      lines.once("close", () => {
        clearTimeout(timer);
        reject(new KernelError("unavailable"));
      });
    });
  } finally {
    lines.close();
  }
}
async function qualify(): Promise<void> {
  assert.equal(process.env.AG_NATIVE_RETAINED_JOINED_ALLOW, "disposable_pg17_10");
  const file = process.env.AG_NATIVE_RETAINED_JOINED_FIXTURE,
    dsn = process.env.AG_NATIVE_RETAINED_JOINED_DSN;
  assert.ok(file && isAbsolute(file) && dsn);
  const url = new URL(dsn);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.username, "fixture_owner");
  assert.ok(
    url.port &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/ag_kernel_test_accounts_joined_[a-z0-9_]+$/.test(url.pathname),
  );
  const bytes = await readFile(file);
  assert.ok(bytes.length <= 16_384);
  const fixture = strictJSON(bytes, true) as Fixture;
  identifier(fixture.consumerId);
  loopback(fixture.nativeOrigin);
  assert.equal(fixture.accounts.length, 2);
  assert.deepEqual(
    fixture.accounts.map((a) => a.authKind),
    ["api_key", "oauth"],
  );
  for (const account of fixture.accounts) {
    identifier(account.operationId);
    identifier(account.ownerRef);
    uuid(account.accountRef);
    identifier(account.qualificationRef);
    physicalCandidate(account.descriptor);
    assert.equal(account.descriptor.nativePhysicalIdentity, account.descriptor.generation);
  }
  const [api, oauth] = fixture.accounts;
  assert.equal(api.descriptor.profile, "openai-responses-apikey-v1");
  assert.equal(oauth.descriptor.profile, codexOAuthProfile.profile);
  assert.equal(oauth.descriptor.baseURL, codexOAuthProfile.baseURL);
  assert.equal(oauth.descriptor.model, codexOAuthProfile.model);
  const managementCredential = token("AG_NATIVE_RETAINED_JOINED_CONTROL");
  const callbackCredential = token("AG_NATIVE_RETAINED_JOINED_CALLBACK");
  phase = "database";
  pool = new pg.Pool({ connectionString: dsn, max: 8, connectionTimeoutMillis: 5000 });
  pool.on("error", () => undefined);
  const version = (
    await pool.query("SELECT current_database() AS db,current_setting('server_version') AS version")
  ).rows[0];
  assert.equal(version.db, url.pathname.slice(1));
  assert.match(version.version, /^17\.10(?:$| )/);
  assert.equal(
    (await pool.query("SELECT 1 FROM pg_namespace WHERE nspname IN ('ag_kernel','ag_management')"))
      .rowCount,
    0,
  );
  for (const file of (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort())
    await pool.query(await readFile(new URL("../migrations/" + file, import.meta.url), "utf8"));
  const kernel = new PostgresKernel(pool),
    secrets = new IntentSecrets(randomBytes(32), randomBytes(32));
  const store = new PostgresManagementStore(pool, secrets),
    worker = randomUUID(),
    context = { consumerId: fixture.consumerId };
  await kernel.issuer(context);
  await kernel.heartbeat(context, worker);
  phase = "seed";
  for (const account of fixture.accounts) {
    const d = account.descriptor;
    // Test-only enrollment seed adopts the original Go-created account identity.
    // Production creation still uses normal private enrollment, never these SQLs.
    await pool.query(
      `INSERT INTO ag_kernel.accounts(consumer,ref,owner_ref,profile,display_name,state)
      VALUES ($1,$2,$3,$4,'Joined disposable custody','staging')`,
      [fixture.consumerId, account.accountRef, account.ownerRef, d.profile],
    );
    await pool.query(
      `INSERT INTO ag_kernel.operations(consumer,id,intent,state,account_ref)
      VALUES ($1,$2,$3::jsonb,'pending',$4)`,
      [
        fixture.consumerId,
        account.operationId,
        JSON.stringify({
          kind: "create",
          digest: randomUUID(),
          target: null,
          expectedRevision: null,
          owner: account.ownerRef,
          profile: d.profile,
          name: "Joined disposable custody",
        }),
        account.accountRef,
      ],
    );
    await pool.query(
      `INSERT INTO ag_kernel.candidates(consumer,generation,account_ref,operation_id,profile,
      expected_revision,expected_epoch,state,worker) VALUES ($1,$2,$3,$4,$5,1,1,'creating',$6)`,
      [
        fixture.consumerId,
        d.generation,
        account.accountRef,
        account.operationId,
        d.profile,
        worker,
      ],
    );
    const journal = await store.journal(
      {
        ...context,
        operationId: account.operationId,
        accountRef: account.accountRef,
        ownerRef: account.ownerRef,
        purpose: "create",
      },
      d.generation,
      worker,
      {
        profile: d.profile,
        baseURL: d.baseURL,
        model: d.model,
        qualificationRef: account.qualificationRef,
      },
    );
    await store.saveMapping({ ...journal, descriptor: d });
    assert.equal(
      (
        await kernel.acknowledgeCandidate(context, account.operationId, worker, {
          generation: d.generation,
          nativePhysicalIdentity: d.nativePhysicalIdentity,
          profile: d.profile,
        })
      ).state,
      "applied",
    );
  }
  const profile = {
    profile: api.descriptor.profile,
    baseURL: api.descriptor.baseURL,
    model: api.descriptor.model,
    qualificationRef: api.qualificationRef,
    limits,
    providerTokenUpperBound: 100,
  };
  const publicToken = "joined-test-public-" + randomUUID();
  const oauthPublicToken = "joined-test-public-oauth-" + randomUUID();
  const cfg = {
    native: {
      executable: "/unused",
      sha256: "unused",
      bootstrapFile: "/unused",
      authorityDir: "/unused",
      origin: fixture.nativeOrigin,
      originRef: "joined-test-origin",
      uid: 1,
      gid: 1,
    },
    consumer: {
      ...context,
      managementCredential,
      callbackCredential,
      executionCredential: "joined-test-execution-" + randomUUID(),
      cleanupCredential: "joined-test-cleanup-" + randomUUID(),
    },
    profile,
    oauthEnrollment: {
      enabled: true as const,
      profile: "openai-codex-oauth-responses-v1" as const,
      modelScope: ["gpt-5.6-sol"] as const,
      qualificationRef: oauth.qualificationRef,
      limits,
      providerTokenUpperBound: 100,
    },
    bearers: [
      {
        token: publicToken,
        role: "management" as const,
        ...context,
        ownerRefs: fixture.accounts.map((a) => a.ownerRef),
        profileIds: [profile.profile],
        preparation: {
          accountRefs: [],
          subjectRef: "joined-policy",
          policyRevision: 1,
          bindingRevision: 1,
          profileId: profile.profile,
          limits,
          maxRunMs: 60_000,
        },
      },
    ],
  };
  // Scoped management grants deliberately retain their profile-specific
  // OAuth authority. A single API-key preparation grant cannot authorize OAuth.
  cfg.bearers.push({
    ...cfg.bearers[0],
    token: oauthPublicToken,
    profileIds: [codexOAuthProfile.profile],
    preparation: { ...cfg.bearers[0].preparation, profileId: codexOAuthProfile.profile },
  });
  const control = composeServiceControl(cfg, kernel, store, secrets, worker);
  const enrollment = { originRef: cfg.native.originRef, engineIncarnation: randomUUID(), worker };
  const { authority, transport } = composeServiceNative(cfg, control, kernel, store, enrollment);
  const callbackOrigin = await listen(authority.createServer());
  const origin = await listen(
    createFacade({
      kernel,
      store,
      management: control.management,
      bearers: control.bearers,
      profiles: control.catalog,
      enrollment,
      transport,
      intentHmacKey: randomBytes(32),
      lifecycle: { contract: c.LIFECYCLE_CAPABILITY_CONTRACT, writeGate: "enabled" },
    }),
  );
  const lifecycleFor = (token: string) =>
    createLifecycleClient({
      role: "management",
      origin,
      token,
      capability: c.LIFECYCLE_CAPABILITY_CONTRACT,
      clientContract: c.LIFECYCLE_CLIENT_CONTRACT,
    });
  phase = "ready";
  report({ phase, callbackOrigin, engineIncarnation: enrollment.engineIncarnation });
  await continueAfterReady();
  const results: object[] = [];
  for (const account of fixture.accounts) {
    kind = account.authKind;
    phase = "prepare";
    const lifecycle = lifecycleFor(account.authKind === "oauth" ? oauthPublicToken : publicToken);
    const prepared = async () => {
      const id = randomUUID();
      const operation = await kernel.prepare(context, {
        operationId: id,
        intentDigest: randomUUID(),
        invocationRef: id,
        attemptRef: id,
        permittedAccounts: [account.accountRef],
        profile: account.descriptor.profile,
        policySubject: "joined-policy-" + id,
        policyRevision: 1,
        bindingRevision: 1,
        issuerEpoch: await kernel.issuer(context),
        deadline: new Date(Date.now() + 60_000),
        limits,
      });
      assert.equal(operation.state, "applied");
      assert.ok(operation.executionRef);
      return {
        ref: operation.executionRef,
        saved: await kernel.savedExecution(context, operation.executionRef),
      };
    };
    const before = await lifecycle.get(account.accountRef),
      old = await prepared();
    phase = "suspend";
    const suspension = await lifecycle.suspend(account.accountRef, {
      operationId: randomUUID(),
      expectedMetadataRevision: before.metadataRevision,
    });
    assert.equal(suspension.state, "applied");
    phase = "suspend-readback";
    const suspended = await lifecycle.get(account.accountRef);
    assert.equal(suspended.state, "suspended");
    phase = "retained-custody";
    diagnostic = { expected: "verified", actual: suspended.resumeCustody };
    assert.equal(suspended.resumeCustody, "verified");
    diagnostic = undefined;
    phase = "purpose-isolation";
    if (account.authKind === "oauth")
      for (const route of ["oauth-owner-authority", "oauth-refresh-authority"]) {
        const response = await fetch(callbackOrigin + "/private/native/v1/" + route, {
          method: "POST",
          headers: {
            authorization: "Bearer " + callbackCredential,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            consumerId: fixture.consumerId,
            operationId: account.operationId,
            accountRef: account.accountRef,
            generation: account.descriptor.generation,
          }),
        });
        diagnostic = { route, expected: 403, actual: response.status };
        assert.equal(response.status, 403);
        diagnostic = undefined;
        await response.arrayBuffer();
      }
    assert.deepEqual(
      (await store.mapping(context, account.descriptor.generation))?.descriptor,
      account.descriptor,
    );
    assert.equal(
      Number(
        (
          await pool.query(
            "SELECT count(*) AS n FROM ag_kernel.cleanup WHERE consumer=$1 AND generation=$2",
            [context.consumerId, account.descriptor.generation],
          )
        ).rows[0].n,
      ),
      0,
    );
    const claim = () =>
      kernel.claim(context, old.ref, randomUUID(), worker, old.saved.admission, {
        originRef: enrollment.originRef,
        engineIncarnation: enrollment.engineIncarnation,
        requestNonce: randomUUID(),
      });
    assert.equal((await claim()).dispatch, undefined);
    await assert.rejects(
      prepared,
      (error) => error instanceof KernelError && error.code === "unknown",
    );
    phase = "resume";
    const resumed = await lifecycle.resume(account.accountRef, {
      operationId: randomUUID(),
      expectedMetadataRevision: suspended.metadataRevision,
    });
    assert.ok(resumed.state === "applied");
    assert.equal(resumed.result.account.state, "active");
    assert.equal(resumed.result.account.authorizationEpoch, before.authorizationEpoch + 2);
    assert.equal((await claim()).dispatch, undefined);
    const fresh = await prepared();
    const permitted = await kernel.claim(
      context,
      fresh.ref,
      randomUUID(),
      worker,
      fresh.saved.admission,
      {
        originRef: enrollment.originRef,
        engineIncarnation: enrollment.engineIncarnation,
        requestNonce: randomUUID(),
      },
    );
    assert.ok(permitted.dispatch);
    assert.equal(permitted.dispatch.descriptor.generation, account.descriptor.generation);
    // This qualification does not enter native inference, including OAuth.
    await kernel.rejectBeforeDispatch(context, worker, permitted.dispatch.closure, false);
    await kernel.acknowledgeTransportClosed(context, worker, permitted.dispatch.closure);
    phase = "missing-proof";
    await lifecycle.suspend(account.accountRef, {
      operationId: randomUUID(),
      expectedMetadataRevision: resumed.result.account.metadataRevision,
    });
    const deniedControl = composeServiceControl(
      {
        ...cfg,
        consumer: { ...cfg.consumer, managementCredential: "joined-test-wrong-control-credential" },
      },
      kernel,
      store,
      secrets,
      worker,
    );
    const current = await kernel.account(context, account.accountRef);
    const refused = await deniedControl.management.resume(context, {
      operationId: randomUUID(),
      accountRef: account.accountRef,
      expectedRevision: current.revision,
    });
    assert.equal(refused.state, "rejected");
    assert.equal(refused.code, "custody_unavailable");
    assert.equal((await kernel.account(context, account.accountRef)).state, "suspended");
    results.push({
      authKind: kind,
      retainedIdentity: true,
      oldAuthorityDenied: true,
      newAuthorityAllowed: true,
      missingCustodyDenied: true,
      inferenceRequests: 0,
    });
  }
  phase = "completed";
  report({ phase, contract: "gateway-native-retained-custody-joined/v1", results });
}
try {
  await qualify();
} catch (error) {
  report({
    phase: "failed",
    at: phase,
    authKind: kind,
    ...(diagnostic ? { diagnostic } : {}),
    code:
      error instanceof KernelError
        ? error.code
        : error instanceof assert.AssertionError
          ? "assertion_failed"
          : "qualification_failed",
  });
  process.exitCode = 1;
} finally {
  for (const server of servers.reverse()) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await pool?.end();
}
