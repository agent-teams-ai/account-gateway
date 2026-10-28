import test from "node:test";
import * as lifecycleWire from "@agent-teams/account-gateway/contracts";
import assert from "node:assert/strict";
import { createManagementClient, secretSubmission } from "@agent-teams/account-gateway/http";
import { strictJSON, validateResponses } from "../src/facade-ingress.ts";
import { KernelError } from "../src/domain.ts";
import type {
  AccountStatus,
  DurableKernel,
  ExecutionRead,
  NativeDispatchProof,
  OperationStatus,
  RequestStatus,
  SavedExecution,
} from "../src/domain.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, request } from "node:http";
import type { Server } from "node:http";
import { facadeControlRoute, facadeBoundedReadRoute } from "../src/service-admission.ts";
import { createFacade, FacadeBearers } from "../src/facade.ts";
import type { ManagementBearer } from "../src/facade.ts";
import { IntentSecrets } from "../src/management-store.ts";
import { grokOAuthProfile } from "../src/oauth-profiles.ts";
import { codexOAuthProfile, claudeOAuthProfile } from "../src/management.ts";
import type {
  CandidateJournal,
  CandidateMapping,
  ManagementStore,
  PhysicalCandidate,
} from "../src/management.ts";
import { NativeFailure, NativeOAuthEnrollmentClient } from "../src/native-client.ts";
import {
  composeServiceControl,
  composeServiceNative,
  composeServiceCachedLimits,
  protectedReadSockets,
} from "../src/service.ts";
import {
  openRouterProfile,
  kimiProfile,
  captureServiceBearers,
  captureServiceProfiles,
  ServiceError,
} from "../src/service-config.ts";
import {
  providerConnectionDefinition,
  providerConnectionRegistry,
} from "../src/provider-connections.ts";
import { projectProviderConnections } from "../src/provider-connection-capabilities.ts";
const bytes = (text: string) => Buffer.from(text);
const valid = {
  model: "fixture-model",
  stream: true,
  store: false,
  service_tier: "default",
  input: "fixture",
};
const invalid = (fn: () => unknown) =>
  assert.throws(fn, (e) => e instanceof KernelError && e.code === "invalid");
test("capability projection omits new profiles without configuration and does not invent model settings", () => {
  const configured = [
    {
      profileId: "openai-responses-apikey-v1",
      protocol: "openai-responses" as const,
      modelIds: ["fixture-model"],
    },
  ];
  const projection = projectProviderConnections(configured);
  assert.equal(projection.capabilities.length, 1);
  assert.equal(
    projection.capabilities.some(
      (value) => value.profileId === "glm-coding-global-responses-apikey-v1",
    ),
    false,
  );
  const glm = providerConnectionDefinition("glm-coding-global-responses-apikey-v1");
  assert.equal(glm?.models[0].modelId, "glm-5.3-flash");
  assert.equal(glm?.models[0].reasoning, null);
  const openrouter = projectProviderConnections([{ profileId: "openrouter-openai-responses-apikey-v1", protocol: "openai-responses", modelIds: ["future-vendor/birth-anchor"] }]);
  assert.deepEqual(providerConnectionDefinition("openrouter-openai-responses-apikey-v1")?.models, []);
  assert.deepEqual(openrouter.capabilities[0]?.models, [{ modelId: "future-vendor/birth-anchor", reasoning: null, fast: null, tools: { allowed: ["none"], default: "none" } }]);
});
test("Grok manual callback grammar is profile-owned and cannot select another provider", () => {
  const state = "a".repeat(64);
  assert.deepEqual(
    secretSubmission.parseGrokManualCallbackURL(
      `http://127.0.0.1:56121/callback?code=fixture&state=${state}`,
    ),
    { code: "fixture", state },
  );
  for (const value of [
    `http://localhost:56121/callback?code=fixture&state=${state}`,
    `http://127.0.0.1:56121/callback?code=fixture&state=${state}&provider=claude`,
    `http://127.0.0.1:56121/callback?code=fixture%23fragment&state=${state}`,
    `http://127.0.0.1:56121/callback?code=fixture&state=${state}&state=${state}`,
  ])
    assert.equal(secretSubmission.parseGrokManualCallbackURL(value), undefined);
});
test("decoded duplicate names, malformed UTF-8 and bounded nesting deny ingress", () => {
  invalid(() => strictJSON(bytes('{"model":"a","\\u006dodel":"b"}')));
  invalid(() => strictJSON(bytes('{"outer":{"key":1,"\\u006bey":2}}')));
  invalid(() => strictJSON(new Uint8Array([0x22, 0xff, 0x22])));
  invalid(() => strictJSON(bytes("[".repeat(66) + "0" + "]".repeat(66))));
  assert.deepEqual(strictJSON(bytes('{"\\u006bey":1,"value":"literal \\\"key\\\""}')), {
    key: 1,
    value: 'literal "key"',
  });
});
test("Responses permits the provider default when no service tier is requested", () => {
  const { service_tier: _tier, ...request } = valid;
  assert.equal(
    validateResponses(bytes(JSON.stringify(request)), ["fixture-model"], 100),
    "fixture-model",
  );
  for (const service_tier of [null, false, "auto", "priority", "flex"])
    invalid(() =>
      validateResponses(
        bytes(JSON.stringify({ ...request, service_tier })),
        ["fixture-model"],
        100,
      ),
    );
});

test("source-qualified model capabilities reject configured reasoning for the four new profiles", () => {
  const profiles = providerConnectionRegistry.filter(
    (profile) => profile.limitsContract === "account-limits/v2",
  );
  assert.equal(profiles.length, 4);
  for (const profile of profiles) {
    const model = profile.models[0];
    const request = { ...valid, model: model.modelId };
    for (const reasoning of [undefined, null])
      assert.equal(
        validateResponses(
          bytes(JSON.stringify({ ...request, reasoning })),
          [model.modelId],
          100,
          profile.models,
        ),
        model.modelId,
      );
    for (const reasoning of [{ effort: "xhigh" }, {}, false, "high"])
      invalid(() =>
        validateResponses(
          bytes(JSON.stringify({ ...request, reasoning })),
          [model.modelId],
          100,
          profile.models,
        ),
      );
    invalid(() =>
      validateResponses(
        bytes(JSON.stringify({ ...request, service_tier: "priority" })),
        [model.modelId],
        100,
        profile.models,
      ),
    );
  }
  for (const profile of providerConnectionRegistry.filter(
    (profile) => profile.limitsContract === "account-limits/v1",
  ))
    assert.equal(
      validateResponses(
        bytes(
          JSON.stringify({
            ...valid,
            model: profile.models[0].modelId,
            reasoning: { effort: "high" },
          }),
        ),
        [profile.models[0].modelId],
        100,
        profile.models,
      ),
      profile.models[0].modelId,
    );
});

test("account-disabled reasoning accepts precisely the empty Codex JSON object without changing request bytes", () => {
  const policy = [{ modelId: "fixture-model", reasoning: null }];
  const raw = bytes('{"model":"fixture-model","stream":true,"store":false,"reasoning":{}}');
  const before = Buffer.from(raw);
  assert.equal(validateResponses(raw, ["fixture-model"], 100, policy, true), "fixture-model");
  assert.deepEqual(raw, before);
  for (const reasoning of [undefined, null])
    assert.equal(validateResponses(bytes(JSON.stringify({ ...valid, reasoning })), ["fixture-model"], 100, policy, true), "fixture-model");
  for (const reasoning of [
    { effort: "high" }, { summary: "none" }, { context: "all_turns" }, { unknown: null },
    JSON.parse('{"__proto__":{}}'), [], [{}], false, 0, "",
  ])
    invalid(() => validateResponses(bytes(JSON.stringify({ ...valid, reasoning })), ["fixture-model"], 100, policy, true));
  // Existing static provider admission does not acquire the Codex-only exception.
  invalid(() => validateResponses(raw, ["fixture-model"], 100, policy));
});

test("Responses policy rejects critical aliases and unsafe provider options before transport", () => {
  for (const patch of [
    { store: true },
    { stream: false },
    { service_tier: "priority" },
    { previous_response_id: "old" },
    { model: "unqualified" },
    { MAX_OUTPUT_TOKENS: 20 },
    { "\uff33tore": false },
  ]) {
    invalid(() =>
      validateResponses(bytes(JSON.stringify({ ...valid, ...patch })), ["fixture-model"], 100),
    );
  }
});
test("output cap lexical precision cannot round a fractional or exponential authority into an integer", () => {
  for (const cap of ["1.000000000000000001", "1e1", "0", "-1", "null", '"10"', "101"]) {
    invalid(() =>
      validateResponses(
        bytes(JSON.stringify(valid).slice(0, -1) + ',"max_output_tokens":' + cap + "}"),
        ["fixture-model"],
        100,
      ),
    );
  }
  validateResponses(
    bytes(JSON.stringify({ ...valid, max_output_tokens: 100 })),
    ["fixture-model"],
    100,
  );
});
test("qualified canonical escapes and unrelated tool text preserve original request bytes", () => {
  const raw = bytes(
    '{"\\u006dodel":"fixture-model","stream":true,"store":false,"service_tier":"default","input":[{"content":"MAX_OUTPUT_TOKENS user text"}]}',
  );
  const before = Buffer.from(raw);
  validateResponses(raw, ["fixture-model"], 100);
  assert.deepEqual(raw, before);
});

test("SDK control numeric tokens cannot round into an accepted integer authority", () => {
  for (const token of [
    "1.000000000000000001",
    "0.0000000000000000000000000000000000000000000000000001",
    "1e0",
    "-0",
    "9007199254740991.1",
  ]) {
    invalid(() =>
      strictJSON(bytes('{"policyRevision":' + token + ',"limits":{"tokens":100}}'), true),
    );
    invalid(() => strictJSON(bytes('{"limits":{"requestBytes":' + token + "}}"), true));
  }
  assert.deepEqual(
    strictJSON(
      bytes('{"policyRevision":0,"bindingRevision":9007199254740991,"limits":{"tokens":100}}'),
      true,
    ),
    { policyRevision: 0, bindingRevision: 9007199254740991, limits: { tokens: 100 } },
  );
  // Opaque native request values retain ordinary JSON numeric semantics.
  const raw = bytes(JSON.stringify({ ...valid, temperature: 0.25, input: [{ user_value: 1.5 }] }));
  validateResponses(raw, ["fixture-model"], 100);
  assert.equal((strictJSON(raw) as { temperature: number }).temperature, 0.25);
});

// RED if browser URL normalization admits aliases or silently changes code,
// or if UTF-8 byte bounds are replaced by JavaScript character counts.
test("OAuth callback ingress accepts genuine encoding and rejects aliases, malformed bytes and secret overflow", () => {
  const state = "a".repeat(64),
    callback = (code: string, scope = "") =>
      "http://localhost:1455/auth/callback?code=" + code + "&state=" + state + scope;
  const accepted = callback("fixture%2Bcode%2F%C3%A9", "&scope=openid+profile");
  assert.deepEqual(secretSubmission.parseOAuthCallbackURL(accepted), {
    code: "fixture+code/é",
    state,
  });
  assert.equal(
    secretSubmission.oauthCallbackURL.safeParse(callback("x".repeat(4096))).success,
    true,
  );
  assert.equal(
    secretSubmission.oauthCallbackURL.safeParse(callback("x", "&scope=" + "s".repeat(1024)))
      .success,
    true,
  );
  for (const value of [
    accepted.replace("localhost:", "127.0.0.1:"),
    accepted.replace("localhost:", "owner@localhost:"),
    accepted.replace("/auth/callback?", "/auth/%63allback?"),
    accepted.replace("/auth/callback?", "/auth/../auth/callback?"),
    accepted + "#",
    accepted + "&code=second",
    accepted + "&scope=second",
    accepted.replace("code=", "%63ode="),
    accepted.replace("code=", "Code="),
    accepted + "&extra=1",
    callback(""),
    callback("%20x"),
    callback("x%20"),
    callback("%00x"),
    callback("%C2%85x"),
    callback("%FF"),
    callback("%"),
    callback("x".repeat(4097)),
    callback("é".repeat(2049)),
    callback("x", "&scope=" + "é".repeat(513)),
    callback("x").replace(state, state.toUpperCase()),
    callback("x").replace(state, "a".repeat(63)),
    callback("%C3%A9".repeat(1400)),
    "http://localhost:1455/auth/callback?",
  ]) {
    assert.equal(secretSubmission.oauthCallbackURL.safeParse(value).success, false);
  }
  assert.equal(
    secretSubmission.oauthComplete.safeParse({
      operationId: "original",
      ownerRef: "owner-one",
      callbackURL: accepted,
      accountRef: randomUUID(),
    }).success,
    false,
  );
});

// Source boundary fixtures have test-owned committed state and real HTTP hops.
// They qualify neither SQL transactions nor Go middleware/provider transport.
async function sourceHTTP(
  oauth: boolean | "claude" | "grok",
  outputEnvelope = false,
  limitsRead?: { contract: "v1" | "v2"; enter(): Promise<void> },
  omitModelSource = false,
) {
  const oauthProfile =
    oauth === "grok"
      ? grokOAuthProfile
      : oauth === "claude"
        ? claudeOAuthProfile
        : codexOAuthProfile;
  const oauthPath =
    "/private/native/v1/" +
    (oauth === "grok" ? "grok/oauth" : oauth === "claude" ? "claude/oauth" : "oauth");
  const consumerId = "source-consumer",
    worker = randomUUID();
  let issuer: string = randomUUID();
  const context = { consumerId },
    enrollment = { originRef: "source-origin", engineIncarnation: randomUUID(), worker };
  const limits = outputEnvelope
    ? {
        requests: 640,
        concurrency: 1,
        requestBytes: 1_048_576,
        outputBytes: 1_048_576,
        tokens: 32_768,
      }
    : { requests: 4, concurrency: 1, requestBytes: 4096, outputBytes: 8192, tokens: 100 };
  const profile = {
    profile: "openai-responses-apikey-v1",
    baseURL: "https://api.xiaomimimo.com/v1",
    model: "mimo-v2-flash",
    qualificationRef: "source-mimo",
    limits,
    providerTokenUpperBound: outputEnvelope ? 32_768 : 1000,
  };
  const secondProfile = {
    ...openRouterProfile,
    qualificationRef: "source-openrouter",
    providerTokenUpperBound: outputEnvelope ? 32_768 : 2000,
    limits: outputEnvelope
      ? limits
      : { requests: 2, concurrency: 1, requestBytes: 2048, outputBytes: 4096, tokens: 50 },
  };
  const consumer = {
    consumerId,
    managementCredential: "source-native-management",
    executionCredential: "source-native-execution",
    cleanupCredential: "source-native-cleanup",
    callbackCredential: "source-native-callback",
  };
  const accounts = new Map<string, AccountStatus>(),
    operations = new Map<string, OperationStatus>();
  const preparationIntents = new Map<string, string>();
  const journals = new Map<string, CandidateJournal>(),
    mappings = new Map<string, CandidateMapping>();
  const executions = new Map<string, SavedExecution>(),
    requests = new Map<string, RequestStatus>(),
    proofs = new Map<string, NativeDispatchProof>();
  const executionCleanup = new Set<string>();
  const custody = new IntentSecrets(randomBytes(32), randomBytes(32));
  const staged = new Map<string, string>();
  const scopeKey = (c: { consumerId: string }, id: string) => JSON.stringify([c.consumerId, id]);
  const missing = (): never => {
    throw new KernelError("unknown");
  };
  const kernel: DurableKernel & ExecutionRead = {
    issuer: async () => issuer,
    heartbeat: async () => {},
    reconcile: async () => {},
    account: async (c, id) => accounts.get(scopeKey(c, id)) ?? missing(),
    accountLimitsIdentity: async (c, id) => {
      const account = await kernel.account(c, id);
      const mapping = [...mappings.values()].find((m) => m.consumerId === c.consumerId && m.accountRef === id);
      if (!mapping) return missing();
      return { ...account, generation: mapping.generation, nativePhysicalIdentity: mapping.descriptor.nativePhysicalIdentity };
    },
    operation: async (c, id) => operations.get(scopeKey(c, id)) ?? missing(),
    accounts: async (c, query = {}) => {
      const rows = [...accounts.values()]
        .filter(
          (a) =>
            accounts.has(scopeKey(c, a.accountRef)) &&
            (!query.ownerRef || a.ownerRef === query.ownerRef) &&
            (!query.allowedOwnerRefs || query.allowedOwnerRefs.includes(a.ownerRef)) &&
            (!query.cursor || a.accountRef > query.cursor),
        )
        .sort((a, b) => a.accountRef.localeCompare(b.accountRef));
      const page = rows.slice(0, query.limit ?? 100);
      return {
        accounts: page,
        ...(rows.length > page.length ? { nextCursor: page.at(-1)!.accountRef } : {}),
      };
    },
    async beginAccount(c, intent) {
      const key = scopeKey(c, intent.operationId),
        old = operations.get(key);
      if (old) return old;
      if (intent.kind !== "create") {
        const account = await kernel.account(c, intent.accountRef!);
        if (account.revision !== intent.expectedRevision) throw new KernelError("conflict");
        const op: OperationStatus = {
          operationRef: intent.operationId,
          accountRef: account.accountRef,
          state: "pending",
        };
        if (intent.kind === "rename" || intent.kind === "disable") {
          if (intent.kind === "rename") account.displayName = intent.displayName!;
          else {
            account.state = "disabled";
            account.epoch++;
          }
          account.revision++;
          op.state = "applied";
          op.revision = account.revision;
          op.epoch = account.epoch;
        }
        operations.set(key, op);
        return op;
      }
      if (!intent.ownerRef || !intent.profile) return missing();
      const accountRef = randomUUID();
      accounts.set(scopeKey(c, accountRef), {
        accountRef,
        ownerRef: intent.ownerRef,
        profile: intent.profile,
        displayName: intent.displayName!,
        state: "staging",
        revision: 1,
        epoch: 1,
      });
      const op: OperationStatus = {
        operationRef: intent.operationId,
        accountRef,
        state: "pending",
      };
      operations.set(key, op);
      return op;
    },
    async startCandidate(c, id) {
      const op = await kernel.operation(c, id),
        account = await kernel.account(c, op.accountRef!);
      return { operationRef: id, candidate: randomUUID(), profile: account.profile };
    },
    async acknowledgeCandidate(c, id) {
      const op = await kernel.operation(c, id),
        account = await kernel.account(c, op.accountRef!);
      if (op.state !== "pending") return op;
      if (account.state === "active") {
        account.revision++;
        account.epoch++;
      }
      account.state = "active";
      op.state = "applied";
      op.revision = account.revision;
      op.epoch = account.epoch;
      return op;
    },
    async unknownCandidate(c, id) {
      const op = await kernel.operation(c, id);
      op.state = "unknown";
      return op;
    },
    async prepare(c, approval) {
      const key = scopeKey(c, approval.operationId),
        old = operations.get(key);
      if (old) {
        if (preparationIntents.get(key) !== approval.intentDigest)
          throw new KernelError("conflict");
        return old;
      }
      const account = await kernel.account(c, approval.permittedAccounts[0]);
      const mapping = [...mappings.values()].find(
        (m) => m.consumerId === c.consumerId && m.accountRef === account.accountRef,
      );
      if (!mapping || account.state !== "active") return missing();
      const executionRef = randomUUID(),
        deadline = approval.deadline.toISOString();
      const saved: SavedExecution = {
        generation: mapping.generation,
        state: "open",
        dispatchAllowed: true,
        admission: {
          executionRef,
          issuerEpoch: issuer,
          invocationRef: approval.invocationRef,
          attemptRef: approval.attemptRef,
          accountRef: account.accountRef,
          authorizationEpoch: account.epoch,
          subjectRef: approval.policySubject,
          policyRevision: approval.policyRevision,
          bindingRevision: approval.bindingRevision,
          profileId: approval.profile,
          expiresAt: deadline,
          limits: { ...approval.limits },
        },
      };
      executions.set(scopeKey(c, executionRef), saved);
      const op: OperationStatus = {
        operationRef: approval.operationId,
        executionRef,
        accountRef: account.accountRef,
        deadline,
        epoch: account.epoch,
        state: "applied",
      };
      preparationIntents.set(key, approval.intentDigest);
      operations.set(key, op);
      return op;
    },
    savedExecution: async (c, id) => executions.get(scopeKey(c, id)) ?? missing(),
    currentWorkerLease: async () => new Date(Date.now() + 30_000).toISOString(),
    request: async (c, ref, id) => requests.get(scopeKey(c, ref + ":" + id)) ?? missing(),
    requestProof: async (c, ref, id) => proofs.get(scopeKey(c, ref + ":" + id)),
    async claim(c, ref, id, w, admission, reservation) {
      const key = scopeKey(c, ref + ":" + id),
        old = requests.get(key);
      if (old) return { status: old };
      const saved = await kernel.savedExecution(c, ref),
        mapping = mappings.get(scopeKey(c, saved.generation))!;
      const status: RequestStatus = { requestRef: id, effect: "dispatch_started" };
      const closure = {
        executionRef: ref,
        requestRef: id,
        worker: w,
        token: randomUUID(),
        native: { ...reservation, generation: saved.generation },
      };
      requests.set(key, status);
      proofs.set(key, closure);
      return {
        status,
        dispatch: {
          descriptor: mapping.descriptor,
          executionRef: ref,
          requestRef: id,
          closure,
          limits: admission.limits,
          deadline: admission.expiresAt,
        },
      };
    },
    async effect(c, ref, id, _w, effect) {
      const status = await kernel.request(c, ref, id);
      status.effect = effect;
      return status;
    },
    acknowledgeTransportClosed: async () => {},
    execution: async (c, id) => {
      const s = await kernel.savedExecution(c, id);
      return {
        executionRef: id,
        accountRef: s.admission.accountRef,
        epoch: s.admission.authorizationEpoch,
        state: s.state,
        deadline: s.admission.expiresAt,
      };
    },
    async close(c, operationId, executionRef) {
      const saved = await kernel.savedExecution(c, executionRef);
      // SQL close transitions only open rows; fenced rows retain scoped readback.
      if (saved.state === "open")
        executions.set(scopeKey(c, executionRef), {
          ...saved,
          state: "closed",
          dispatchAllowed: false,
        });
      executionCleanup.add(scopeKey(c, executionRef));
      const op: OperationStatus = {
        operationRef: operationId,
        executionRef,
        accountRef: saved.admission.accountRef,
        state: "applied",
      };
      operations.set(scopeKey(c, operationId), op);
      return op;
    },
    async restore(c, expectedIssuer, freshIssuer) {
      if (expectedIssuer !== issuer) throw new KernelError("conflict");
      if (expectedIssuer === freshIssuer) throw new KernelError("invalid");
      issuer = freshIssuer;
      // Restore fences every execution, including closed rows, without repinning.
      for (const [key, saved] of executions)
        if (key === scopeKey(c, saved.admission.executionRef)) {
          executions.set(key, { ...saved, state: "fenced", dispatchAllowed: false });
          executionCleanup.add(key);
        }
      for (const [key, account] of accounts)
        if (
          key === scopeKey(c, account.accountRef) &&
          ["active", "staging"].includes(account.state)
        ) {
          account.state = "quarantined";
          account.epoch++;
        }
    },
    currentCleanupLease: missing,
    rejectBeforeDispatch: missing,
    fence: missing,
    claimCleanup: missing,
    cleanupTransports: missing,
    settleCleanup: missing,
  };
  const store: ManagementStore = {
    stage: async (s, key) => {
      staged.set(scopeKey(s, s.operationId), key);
      return true;
    },
    async journal(s, generation, w, p) {
      const j = Object.freeze({ ...s, generation, worker: w, profile: Object.freeze({ ...p }) });
      // This method resolves only after this fixture's committed publication.
      journals.set(scopeKey(s, s.operationId), j);
      return j;
    },
    readJournal: async (c, id) => journals.get(scopeKey(c, id)),
    async pendingOAuthRefresh(c, w, input, source) {
      const j = journals.get(scopeKey(c, input.operationId)),
        a = accounts.get(scopeKey(c, input.accountRef)),
        op = operations.get(scopeKey(c, input.operationId));
      if (
        !j ||
        !a ||
        !op ||
        w !== worker ||
        j.worker !== worker ||
        j.consumerId !== input.consumerId ||
        j.accountRef !== input.accountRef ||
        j.generation !== input.generation ||
        j.ownerRef !== a.ownerRef ||
        j.profile.profile !== source.profile ||
        j.profile.baseURL !== source.baseURL ||
        j.profile.model !== source.model ||
        j.profile.qualificationRef !== source.qualificationRef ||
        op.state !== "pending" ||
        a.state !== "staging" ||
        mappings.has(scopeKey(c, j.generation))
      )
        return undefined;
      return j;
    },
    credential: async (s) => staged.get(scopeKey(s, s.operationId)),
    eraseIntent: async (s) => {
      staged.delete(scopeKey(s, s.operationId));
    },
    saveMapping: async (m) => {
      mappings.set(scopeKey(m, m.generation), m);
    },
    mapping: async (c, id) => mappings.get(scopeKey(c, id)),
    cleanupAllowed: async () => false,
    // This source-ingress fixture does not qualify durable lifecycle readback.
    retirement: async () => {
      throw new KernelError("denied");
    },
    policyClosure: async () => {
      throw new KernelError("denied");
    },
    expire: async () => [],
  };
  const nativeRows = new Map<string, { descriptor: Record<string, unknown>; state: string }>();
  const seen: { path: string; tuple: Record<string, unknown> }[] = [],
    forwarded: Record<string, unknown>[] = [];
  const receipts = new Map<string, Record<string, unknown>>();
  let callbackOrigin = "",
    begins = 0,
    completions = 0,
    loseCompletion = false,
    bodyOwner: string | undefined,
    descriptorReply: unknown;
  let responseBytes: number | undefined;
  let connectState: "prepared" | "entered" | "completed" | "expired" | "unknown" = "completed";
  let descriptorMode: "normal" | "redirect" | "overflow" | "headers" | "utf8" | "timeout" =
    "normal";
  const callback = async (route: string, body: unknown, token = consumer.callbackCredential) =>
    fetch(callbackOrigin + "/private/native/v1/" + route, {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
    });
  let modelResult: unknown = { status: "unavailable" };
  let modelHTTPStatus = 200;
  let modelRead: (() => Promise<void>) | undefined;
  const peer = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
      const tuple = chunks.length
        ? (strictJSON(Buffer.concat(chunks)) as Record<string, unknown>)
        : {};
      const path = req.url!;
      seen.push({ path: req.method + " " + path, tuple });
      const reply = (body: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "POST" && path === "/private/native/v1/account-models/read") {
        assert.equal(req.headers.authorization, "Bearer " + consumer.managementCredential);
        await modelRead?.();
        reply(modelResult, modelHTTPStatus);
        return;
      }
      if (req.method === "GET" && path === "/private/native/v1/account-limits/capabilities") {
        reply({ contract: "account-limits/v1", cachedRead: true, quotaOnlyRefresh: false });
        return;
      }
      if (
        req.method === "POST" &&
        path === "/private/native/" + limitsRead?.contract + "/account-limits/read" &&
        limitsRead
      ) {
        await limitsRead.enter();
        const grant = await callback("account-limits-authority", { consumerId, ...tuple });
        assert.equal(grant.status, 200);
        reply({ status: "unknown" });
        return;
      }
      if (req.method === "GET" && path === "/private/native/v2/account-limits/capabilities") {
        assert.equal(req.headers.authorization, "Bearer " + consumer.managementCredential);
        reply({ contract: "account-limits/v2", cachedRead: true, quotaOnlyRefresh: false });
        return;
      }
      if (path === oauthPath + "/refresh") {
        assert.equal(req.method, "POST");
        assert.equal(req.headers.authorization, "Bearer " + consumer.managementCredential);
        const grant = await callback("oauth-refresh-authority", {
          consumerId,
          operationId: tuple.operation,
          accountRef: tuple.account_ref,
          generation: tuple.generation,
        });
        if (grant.status !== 200) {
          reply({ code: "denied" }, 403);
          return;
        }
        reply({ operation: tuple.operation, account_ref: tuple.account_ref, state: "idle" });
        return;
      }
      if (path.startsWith(oauthPath + "/connect")) {
        assert.equal(req.method, "POST");
        assert.equal(req.headers.authorization, "Bearer " + consumer.managementCredential);
        assert.deepEqual(
          Object.keys(tuple).sort(),
          path.endsWith("/complete")
            ? oauth === "grok" && "authorizationCode" in tuple
              ? ["account_ref", "authorizationCode", "generation", "operation", "owner_ref"]
              : ["account_ref", "code", "generation", "operation", "owner_ref", "state"]
            : ["account_ref", "generation", "operation", "owner_ref"],
        );
        const grant = await callback("oauth-owner-authority", {
          consumerId,
          operationId: tuple.operation,
          accountRef: tuple.account_ref,
          generation: tuple.generation,
        });
        if (grant.status !== 200) {
          reply({ code: "denied" }, 403);
          return;
        }
        const owner = (await grant.json()) as { ok: true; ownerRef: string };
        if (owner.ownerRef !== (bodyOwner ?? tuple.owner_ref)) {
          reply({ code: "denied" }, 403);
          return;
        }
        if (path.endsWith("/descriptor")) {
          if (descriptorMode === "redirect") {
            res.writeHead(307, { location: "/escaped" });
            res.end();
            return;
          }
          if (descriptorMode === "overflow") {
            res.end(Buffer.alloc(65_537));
            return;
          }
          if (descriptorMode === "headers") {
            for (let i = 0; i < 65; i++) res.setHeader("x-fixture-" + i, "a");
          }
          if (descriptorMode === "utf8") {
            res.end(Buffer.from([0xff]));
            return;
          }
          if (descriptorMode === "timeout") return;
          reply(
            descriptorReply ?? {
              operation: tuple.operation,
              account_ref: tuple.account_ref,
              state: "staged",
              qualification: "pending",
            },
          );
          return;
        }
        if (path === oauthPath + "/connect") begins++;
        if (path.endsWith("/complete")) {
          if (!("authorizationCode" in tuple)) assert.equal(tuple.state, "a".repeat(64));
          completions++;
          if (loseCompletion) {
            req.socket.destroy();
            return;
          }
          connectState = "completed";
        }
        reply({ operation: tuple.operation, account_ref: tuple.account_ref, state: connectState });
        return;
      }
      if (path === "/private/native/v1/candidates" && req.method === "POST") {
        const p = [profile, secondProfile].find((p) => p.profile === tuple.profile)!;
        assert.ok(p);
        assert.equal(req.headers.authorization, "Bearer " + consumer.managementCredential);
        assert.equal(tuple.api_key, "fixture-write-only");
        nativeRows.set(tuple.generation as string, {
          state: "inactive",
          descriptor: {
            generation: tuple.generation,
            account_id: nativeRows.size + 1,
            created_at: "2026-10-06T01:02:03.123456789Z",
            profile: p.profile,
            base_url: p.baseURL,
            model: p.model,
          },
        });
        reply({ ok: true });
        return;
      }
      if (path.startsWith("/private/native/v1/candidates/")) {
        const row = nativeRows.get(path.split("/").at(-1)!)!;
        assert.ok(row);
        if (req.method === "PUT") {
          assert.deepEqual(tuple.descriptor, row.descriptor);
          row.state = tuple.state as string;
        }
        reply({
          ...row,
          name: "Fixture",
          group_free: true,
          schedulable: false,
          probes_enabled: false,
        });
        return;
      }
      if (path === "/private/native/v1/transports") {
        assert.equal(req.headers.authorization, "Bearer " + consumer.executionCredential);
        const { payload, ...admit } = tuple;
        const d = tuple.descriptor as Record<string, unknown>,
          generation = d.generation as string;
        const p = [profile, secondProfile, oauthProfile].find((p) => p.profile === d.profile)!;
        assert.equal(d.base_url, p.baseURL);
        assert.equal(d.model, p.model);
        const native = { ...enrollment, requestNonce: randomUUID(), generation };
        const nativeBinding = {
          originRef: native.originRef,
          engineIncarnation: native.engineIncarnation,
          requestNonce: native.requestNonce,
          generation,
        };
        const result = await callback("admit", { ...admit, consumerId, native: nativeBinding });
        assert.equal(result.status, 200);
        const permit = (await result.json()) as { dispatch: { closure: NativeDispatchProof } };
        assert.ok(permit.dispatch);
        forwarded.push({ profile: d.profile, baseURL: d.base_url, body: payload });
        const proof = permit.dispatch.closure;
        receipts.set(proof.requestRef, {
          consumerId,
          executionRef: proof.executionRef,
          requestRef: proof.requestRef,
          native: nativeBinding,
          proof,
          phase: "closed",
          effect: "completed",
          sealed: true,
          acknowledged: false,
          lifetime: {
            entered: true,
            contextDone: true,
            forwardingReturned: true,
            bodyKnown: true,
            bodyClosed: true,
            closeFailed: false,
            completed: true,
            sealed: true,
          },
        });
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "x-gateway-request-ref": proof.requestRef,
        });
        res.end(
          responseBytes === undefined
            ? 'data: {"type":"response.completed","fixture":"tools-and-final"}\n\n'
            : Buffer.alloc(responseBytes, 0x20),
        );
        return;
      }
      if (
        path === "/private/native/v1/transports/read-owner" ||
        path === "/private/native/v1/transports/ack-owner"
      ) {
        const proof = tuple.proof as NativeDispatchProof,
          r = receipts.get(proof.requestRef)!;
        assert.ok(r);
        if (path.endsWith("/ack-owner")) {
          const ack = await callback("closure-ack", { consumerId, proof, receipt: r });
          assert.equal(ack.status, 200);
          assert.deepEqual(await ack.json(), { ok: true });
          r.acknowledged = true;
        }
        reply(r, 202);
        return;
      }
      reply({ code: "denied" }, 404);
    })().catch(() => {
      res.destroy();
    });
  });
  const servers: Server[] = [peer];
  const listen = async (server: Server) => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const a = server.address();
    assert.ok(a && typeof a === "object");
    return "http://127.0.0.1:" + a.port;
  };
  const origin = await listen(peer);
  const selected = oauth ? oauthProfile.profile : profile.profile;
  const preparation = {
    accountRefs: [],
    subjectRef: "source-subject",
    policyRevision: 1,
    bindingRevision: 1,
    profileId: selected,
    limits: secondProfile.limits,
    maxRunMs: 20_000,
  };
  const managementGrant = {
    token: "source-public-management",
    role: "management" as const,
    consumerId,
    ownerRefs: ["owner-one", "owner-two"],
    preparation,
  };
  const bearers = oauth
    ? [managementGrant]
    : [
        managementGrant,
        {
          token: "source-public-run",
          role: "run-control" as const,
          consumerId,
          ownerRefs: managementGrant.ownerRefs,
          profileIds: [profile.profile, secondProfile.profile],
          limits: secondProfile.limits,
          maxRunMs: 20_000,
        },
      ];
  const cfg = {
    native: {
      executable: "/unused",
      sha256: "unused",
      bootstrapFile: "/unused",
      authorityDir: "/unused",
      origin,
      originRef: enrollment.originRef,
      uid: 1,
      gid: 1,
    },
    consumer,
    profile,
    secondProfile,
    bearers,
    ...(limitsRead?.contract === "v2"
      ? {
          providerProfiles: [
            {
              ...kimiProfile,
              qualificationRef: "source-kimi",
              limits,
              providerTokenUpperBound: 1000,
            },
          ],
        }
      : {}),
    ...(oauth === "grok"
      ? {
          grokOAuthEnrollment: {
            enabled: true as const,
            deploymentQualified: true as const,
            authorizationOrigin: "https://auth.x.ai" as const,
            redirectPolicy: "manual_loopback" as const,
            profile: "grok-subscription-responses-oauth-v1" as const,
            modelScope: ["grok-4.7"] as const,
            clientId: "b1a00492-073a-47ea-816f-4c329264a828",
            redirectURI: "http://127.0.0.1:56121/callback" as const,
            qualificationRef: "source-grok",
            limits,
            providerTokenUpperBound: 1000,
          },
        }
      : oauth === "claude"
        ? {
            claudeOAuthEnrollment: {
              enabled: true as const,
              profile: "anthropic-claude-oauth-messages-v1" as const,
              modelScope: ["claude-sonnet-4-6"] as const,
              qualificationRef: "source-claude",
              limits,
              providerTokenUpperBound: 1000,
            },
          }
        : oauth
          ? {
              oauthEnrollment: {
                enabled: true as const,
                profile: "openai-codex-oauth-responses-v1" as const,
                modelScope: ["gpt-5.6-sol"] as const,
                qualificationRef: "source-codex",
                limits: outputEnvelope ? { ...limits, outputBytes: 8_388_608 } : limits,
                providerTokenUpperBound: outputEnvelope ? 32_768 : 1000,
              },
            }
          : {}),
  };
  const closeServers = async () => {
    for (const s of servers.reverse()) {
      s.closeAllConnections();
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  };
  try {
    const control = composeServiceControl(cfg, kernel, store, custody, worker);
    const { authority, transport } = composeServiceNative(cfg, control, kernel, store, enrollment);
    const callbacks = authority.createServer();
    servers.push(callbacks);
    callbackOrigin = await listen(callbacks);
    const facade = createFacade({
      kernel,
      store,
      management: control.management,
      bearers: control.bearers,
      profiles: control.catalog,
      enrollment,
      transport,
      ...composeServiceCachedLimits(control),
      ...(omitModelSource ? { accountModels: undefined } : {}),
      intentHmacKey: randomBytes(32),
      ingressBytes: outputEnvelope ? 1_048_576 : 4096,
    });
    servers.push(facade);
    const facadeOrigin = await listen(facade);
    const publicCall = (
      path: string,
      body?: unknown,
      token = managementGrant.token,
      headers: Record<string, string> = {},
    ) =>
      fetch(facadeOrigin + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          accept: path.includes("/requests") ? "text/event-stream" : "application/json",
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    return {
      context,
      consumer,
      control,
      authority,
      cfg,
      kernel,
      store,
      journals,
      mappings,
      accounts,
      operations,
      executions,
      requests,
      executionCleanup,
      publicCall,
      callback,
      seen,
      forwarded,
      profile,
      secondProfile,
      begins: () => begins,
      completions: () => completions,
      connect: (state: typeof connectState, lose = false) => {
        connectState = state;
        loseCompletion = lose;
      },
      owner: (value: string | undefined) => {
        bodyOwner = value;
      },
      descriptor: (value: unknown, mode: typeof descriptorMode = "normal") => {
        descriptorReply = value;
        descriptorMode = mode;
      },
      modelResult: (value: unknown, enter?: () => Promise<void>, httpStatus = 200) => {
        modelHTTPStatus = httpStatus;
        modelResult = value;
        modelRead = enter;
      },
      responseBytes: (value: number) => {
        responseBytes = value;
      },
      close: closeServers,
      origin,
      callbackOrigin,
      facade,
      facadeOrigin,
      nativeRows,
      scopeKey,
      callbackOriginTo: (origin: string) => {
        callbackOrigin = origin;
      },
    };
  } catch (error) {
    await closeServers();
    throw error;
  }
}

test("source HTTP: consumer-scoped management isolates explicit owner lists and consumer custody while OAuth enrollment stays separate from execution policy", async () => {
  const f = await sourceHTTP(true);
  try {
    const initial = f.cfg.bearers.find((b) => b.role === "management");
    assert.ok(initial && initial.role === "management");
    const { ownerRefs: _owners, ...base } = initial;
    const scoped = {
      ...base,
      ownerScope: "consumer" as const,
      profileIds: [f.profile.profile, f.secondProfile.profile, codexOAuthProfile.profile],
      preparation: { ...base.preparation, profileId: f.profile.profile },
    };
    const profiles = captureServiceProfiles(f.cfg);
    assert.deepEqual(captureServiceBearers([scoped], f.context.consumerId, profiles), [scoped]);
    // Only an explicit opt-in replaces the old owner list; no wildcard/mixed mode.
    for (const entry of [
      { ...scoped, ownerRefs: ["owner-one"] },
      { ...scoped, ownerScope: "*" },
      { ...base, ownerScope: undefined },
    ]) {
      invalid(() => new FacadeBearers([entry as unknown as ManagementBearer]));
      assert.throws(
        () => captureServiceBearers([entry], f.context.consumerId, profiles),
        (e) => e instanceof ServiceError && e.code === "config_denied",
      );
    }
    f.control.bearers.replace([scoped]);
    // Captured primitives remain authoritative after caller configuration mutation.
    Object.assign(scoped, { ownerScope: "*", consumerId: "foreign-consumer" });
    scoped.profileIds.length = 0;
    const localRef = randomUUID(),
      otherRef = randomUUID(),
      foreignRef = randomUUID();
    const seed = (consumerId: string, accountRef: string, ownerRef: string) =>
      f.accounts.set(f.scopeKey({ consumerId }, accountRef), {
        accountRef,
        ownerRef,
        profile: f.profile.profile,
        displayName: "Fixture",
        state: "active",
        revision: 1,
        epoch: 1,
      });
    seed(f.context.consumerId, localRef, "owner-new");
    seed(f.context.consumerId, otherRef, "owner-other");
    seed("foreign-consumer", foreignRef, "owner-new");
    assert.equal((await f.publicCall("/v1/accounts")).status, 403);
    assert.equal((await f.publicCall("/v1/accounts?ownerRef=*")).status, 400);
    const list = await f.publicCall("/v1/accounts?ownerRef=owner-new");
    assert.equal(list.status, 200);
    assert.deepEqual(
      ((await list.json()) as { accounts: { accountRef: string }[] }).accounts.map(
        (a) => a.accountRef,
      ),
      [localRef],
    );
    assert.notEqual((await f.publicCall("/v1/accounts/" + foreignRef)).status, 200);
    assert.equal(
      f.control.bearers.authorizesOwner(
        { consumerId: "foreign-consumer" },
        "owner-new",
        codexOAuthProfile.profile,
      ),
      false,
    );
    assert.equal(
      f.control.bearers.authorizesOwner(f.context, "owner-new", "unqualified-profile"),
      false,
    );
    let prepares = 0;
    f.kernel.prepare = async () => {
      prepares++;
      throw new KernelError("denied");
    };
    const operationId = randomUUID();
    const begun = await f.publicCall("/v1/accounts/oauth/begin", {
      operationId,
      ownerRef: "owner-new",
      profileId: codexOAuthProfile.profile,
      displayName: "Fixture",
    });
    assert.equal(begun.status, 202);
    assert.equal(f.begins(), 1);
    const journal = f.journals.get(f.scopeKey(f.context, operationId))!;
    assert.equal(
      (
        await f.callback("oauth-owner-authority", {
          consumerId: journal.consumerId,
          operationId,
          accountRef: journal.accountRef,
          generation: journal.generation,
        })
      ).status,
      200,
    );
    const prepare = await f.publicCall("/v1/executions", {
      operationId: randomUUID(),
      invocationRef: "source-invocation",
      attemptRef: "attempt",
      accountRefs: [journal.accountRef],
      profileId: codexOAuthProfile.profile,
      subjectRef: base.preparation.subjectRef,
      policyRevision: base.preparation.policyRevision,
      bindingRevision: base.preparation.bindingRevision,
      limits: base.preparation.limits,
      deadline: new Date(Date.now() + 10_000).toISOString(),
    });
    assert.equal(prepare.status, 403);
    assert.equal(prepares, 0);
    const narrowed = { ...base, ownerScope: "consumer" as const, profileIds: [f.profile.profile] };
    f.control.bearers.replace([narrowed]);
    let operationReads = 0;
    const originalOperation = f.control.management.operation.bind(f.control.management);
    f.control.management.operation = async (...args) => {
      operationReads++;
      return originalOperation(...args);
    };
    const nativeCalls = f.seen.length;
    assert.equal((await f.publicCall("/v1/operations/" + operationId)).status, 403);
    assert.equal(operationReads, 0);
    assert.equal(f.seen.length, nativeCalls);
    // Replacement while a committed read waits revokes its captured reply.
    let enteredList!: () => void, releaseList!: () => void;
    const listEntered = new Promise<void>((resolve) => {
      enteredList = resolve;
    });
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    const originalAccounts = f.kernel.accounts.bind(f.kernel);
    f.kernel.accounts = async (...args) => {
      enteredList();
      await listGate;
      return originalAccounts(...args);
    };
    const pendingList = f.publicCall("/v1/accounts?ownerRef=owner-new");
    await listEntered;
    f.control.bearers.replace([narrowed]);
    releaseList();
    assert.equal((await pendingList).status, 403);
    f.kernel.accounts = originalAccounts;
    const pendingId = randomUUID();
    f.operations.set(f.scopeKey(f.context, pendingId), {
      operationRef: pendingId,
      accountRef: localRef,
      state: "pending",
    });
    let enteredOperation!: () => void, releaseOperation!: () => void;
    const operationEntered = new Promise<void>((resolve) => {
      enteredOperation = resolve;
    });
    const operationGate = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    f.control.management.operation = async (...args) => {
      enteredOperation();
      await operationGate;
      return originalOperation(...args);
    };
    const pendingOperation = f.publicCall("/v1/operations/" + pendingId);
    await operationEntered;
    f.control.bearers.replace([narrowed]);
    releaseOperation();
    assert.equal((await pendingOperation).status, 403);
    f.control.management.operation = originalOperation;
    f.control.bearers.replace([initial]);
    assert.equal((await f.publicCall("/v1/accounts?ownerRef=owner-new")).status, 403);
    assert.equal((await f.publicCall("/v1/accounts/" + localRef)).status, 403);
    assert.equal(
      (
        await f.callback("oauth-owner-authority", {
          consumerId: journal.consumerId,
          operationId,
          accountRef: journal.accountRef,
          generation: journal.generation,
        })
      ).status,
      403,
    );
  } finally {
    await f.close();
  }
});

test("source HTTP: current management fences monotonically for its exact subject while prepare stays pinned", async () => {
  const f = await sourceHTTP(false);
  try {
    const initial = f.cfg.bearers.find((b) => b.role === "management");
    assert.ok(initial && initial.role === "management");
    const accountRef = randomUUID();
    f.accounts.set(f.scopeKey(f.context, accountRef), {
      accountRef,
      ownerRef: "owner-one",
      profile: initial.preparation.profileId,
      displayName: "GX fixture",
      state: "active",
      revision: 1,
      epoch: 1,
    });
    const gx = {
      ...initial,
      ownerRefs: ["owner-one"],
      preparation: {
        ...initial.preparation,
        accountRefs: [accountRef],
        subjectRef: "source-subject-GX",
        policyRevision: 2,
      },
    };
    // X and Y share the canonical account owner but have distinct binding subjects.
    const gy = {
      ...gx,
      token: "source-public-management-Y",
      preparation: { ...gx.preparation, subjectRef: "source-subject-Y" },
    };
    const entries = [gx, gy, ...f.cfg.bearers.filter((b) => b.role === "run-control")];
    f.control.bearers.replace(entries);
    // Controlled kernel records only facade authorization; it certifies no SQL fence/closure behavior.
    const calls: Parameters<DurableKernel["fence"]>[] = [];
    f.kernel.fence = async (...args) => {
      calls.push(args);
      return { operationRef: args[1], state: "applied" };
    };
    let prepares = 0;
    f.kernel.prepare = async () => {
      prepares++;
      throw new KernelError("denied");
    };
    const input = { operationId: randomUUID(), subjectRef: gx.preparation.subjectRef, revision: 3 };
    const applied = await f.publicCall("/v1/policy-fences", input, gx.token);
    assert.deepEqual({ status: applied.status, calls: calls.length }, { status: 200, calls: 1 });
    assert.deepEqual(await applied.json(), { operationRef: input.operationId, state: "applied" });
    assert.deepEqual(calls, [[f.context, input.operationId, gx.preparation.subjectRef, 3]]);
    const denied = async (body: typeof input, token = gx.token) => {
      const response = await f.publicCall("/v1/policy-fences", body, token);
      assert.equal(response.status, 403);
      const error = (await response.json()) as { code: string; effect: string };
      assert.equal(error.code, "forbidden");
      assert.equal(error.effect, "not_dispatched");
      assert.equal(calls.length, 1);
    };
    await denied({ ...input, operationId: randomUUID(), subjectRef: gy.preparation.subjectRef });
    await denied({ ...input, operationId: randomUUID(), revision: 1 });
    await denied({ ...input, operationId: randomUUID() }, gy.token);
    await denied({ ...input, operationId: randomUUID() }, "source-public-run");
    const prepare = await f.publicCall(
      "/v1/executions",
      {
        operationId: randomUUID(),
        invocationRef: "source-invocation-GX",
        attemptRef: "attempt",
        accountRefs: [accountRef],
        profileId: gx.preparation.profileId,
        subjectRef: gx.preparation.subjectRef,
        policyRevision: 3,
        bindingRevision: gx.preparation.bindingRevision,
        limits: gx.preparation.limits,
        deadline: new Date(Date.now() + 10_000).toISOString(),
      },
      gx.token,
    );
    assert.equal(prepare.status, 403);
    assert.equal(((await prepare.json()) as { effect: string }).effect, "not_dispatched");
    assert.equal(prepares, 0);
    assert.equal(calls.length, 1);
    // Send headers alone so the real handler captures GX and awaits its body.
    // Replacing even the same token retires that captured immutable capability.
    const captured = new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        f.facade.off("request", onRequest);
        reject(error);
      };
      const onRequest = () => {
        f.facade.off("error", onError);
        resolve();
      };
      f.facade.once("request", onRequest);
      f.facade.once("error", onError);
    });
    let stale: ReturnType<typeof request> | undefined;
    const staleResponse = new Promise<number>((resolve, reject) => {
      stale = request(
        f.facadeOrigin + "/v1/policy-fences",
        {
          method: "POST",
          headers: {
            authorization: "Bearer " + gx.token,
            "content-type": "application/json",
            accept: "application/json",
            "transfer-encoding": "chunked",
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      stale.on("error", reject);
      stale.flushHeaders();
    });
    try {
      await captured;
      f.control.bearers.replace(entries);
      stale!.end(JSON.stringify({ ...input, operationId: randomUUID() }));
      assert.equal(await staleResponse, 403);
      assert.equal(calls.length, 1);
    } finally {
      stale?.destroy();
    }
    const replacement = { ...gx, token: "source-public-management-replaced" };
    f.control.bearers.replace([replacement, gy]);
    const retired = await f.publicCall(
      "/v1/policy-fences",
      { ...input, operationId: randomUUID() },
      gx.token,
    );
    assert.equal(retired.status, 401);
    assert.equal(((await retired.json()) as { effect: string }).effect, "not_dispatched");
    assert.equal(calls.length, 1);
    const currentInput = { ...input, operationId: randomUUID() };
    const current = await f.publicCall("/v1/policy-fences", currentInput, replacement.token);
    assert.equal(current.status, 200);
    assert.deepEqual(await current.json(), {
      operationRef: currentInput.operationId,
      state: "applied",
    });
    assert.deepEqual(calls, [
      [f.context, input.operationId, gx.preparation.subjectRef, 3],
      [f.context, currentInput.operationId, gx.preparation.subjectRef, 3],
    ]);
    assert.equal(f.seen.length, 0);
    assert.equal(f.forwarded.length, 0);
  } finally {
    await f.close();
  }
});

test("source HTTP: owner lookup resolves two original pending journals, revocation and foreign selectors deny", async () => {
  const f = await sourceHTTP(true);
  try {
    const ids = [randomUUID(), randomUUID()];
    for (const [i, operationId] of ids.entries()) {
      const response = await f.publicCall("/v1/accounts/oauth/begin", {
        operationId,
        ownerRef: "owner-" + (i ? "two" : "one"),
        profileId: codexOAuthProfile.profile,
        displayName: "Source fixture",
      });
      assert.equal(response.status, 202);
      const safe = (await response.json()) as { operation: { state: string } };
      assert.equal(safe.operation.state, "pending");
    }
    assert.equal(f.begins(), 2);
    assert.equal(f.mappings.size, 0);
    const js = ids.map((id) => f.journals.get(f.scopeKey(f.context, id))!);
    assert.equal(js[0].ownerRef, "owner-one");
    assert.equal(js[1].ownerRef, "owner-two");
    const lookup = (j: CandidateJournal) => ({
      consumerId: j.consumerId,
      operationId: j.operationId,
      accountRef: j.accountRef,
      generation: j.generation,
    });
    for (const j of js) {
      const r = await f.callback("oauth-owner-authority", lookup(j));
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { ok: true, ownerRef: j.ownerRef });
      const before = f.seen.length,
        read = await f.publicCall("/v1/operations/" + j.operationId);
      assert.equal(read.status, 200);
      assert.equal(((await read.json()) as { state: string }).state, "pending");
      assert.deepEqual(
        f.seen.slice(before).map((s) => s.path),
        [
          "POST /private/native/v1/oauth/connect/read",
          "POST /private/native/v1/oauth/refresh",
          "POST /private/native/v1/oauth/connect/descriptor",
        ],
      );
      assert.deepEqual(
        f.seen.slice(before).map((s) => s.tuple),
        Array(3).fill({
          operation: j.operationId,
          owner_ref: j.ownerRef,
          account_ref: j.accountRef,
          generation: j.generation,
        }),
      );
    }
    for (const patch of [
      { consumerId: "foreign" },
      { operationId: randomUUID() },
      { operationId: js[1].operationId },
      { generation: js[1].generation },
      { accountRef: js[1].accountRef },
      { ownerRef: js[1].ownerRef },
      { generation: js[0].generation.toUpperCase() },
    ]) {
      assert.equal(
        (await f.callback("oauth-owner-authority", { ...lookup(js[0]), ...patch })).status,
        403,
      );
    }
    assert.equal(
      (await f.callback("oauth-owner-authority", lookup(js[0]), f.consumer.managementCredential))
        .status,
      403,
    );
    const rawLookup = (body: string) =>
      fetch(f.callbackOrigin + "/private/native/v1/oauth-owner-authority", {
        method: "POST",
        headers: {
          authorization: "Bearer " + f.consumer.callbackCredential,
          "content-type": "application/json",
        },
        body,
      });
    assert.equal(
      (
        await rawLookup(
          JSON.stringify(lookup(js[0])).slice(0, -1) +
            ',"\\u0067eneration":"' +
            js[1].generation +
            '"}',
        )
      ).status,
      403,
    );
    await assert.rejects(
      rawLookup(JSON.stringify({ ...lookup(js[0]), operationId: "x".repeat(1025) })),
    );
    const originalOp = f.operations.get(f.scopeKey(f.context, js[0].operationId))!;
    f.operations.set(f.scopeKey(f.context, js[0].operationId), {
      ...originalOp,
      accountRef: js[1].accountRef,
    });
    assert.equal((await f.callback("oauth-owner-authority", lookup(js[0]))).status, 403);
    f.operations.set(f.scopeKey(f.context, js[0].operationId), originalOp);
    const originalJournal = js[0];
    f.journals.set(f.scopeKey(f.context, js[0].operationId), {
      ...originalJournal,
      ownerRef: js[1].ownerRef,
    });
    assert.equal((await f.callback("oauth-owner-authority", lookup(js[0]))).status, 403);
    f.journals.set(f.scopeKey(f.context, js[0].operationId), originalJournal);
    const tuple = { ...js[0], ownerRef: js[1].ownerRef };
    const fixed = new NativeOAuthEnrollmentClient({
      origin: f.origin,
      consumerId: f.context.consumerId,
      controlCredential: f.consumer.managementCredential,
      ownerRef: js[0].ownerRef,
    });
    const seen = f.seen.length;
    await assert.rejects(
      fixed.begin(tuple),
      (e) => e instanceof NativeFailure && e.code === "denied",
    );
    assert.equal(f.seen.length, seen);
    f.owner(js[1].ownerRef);
    await assert.rejects(fixed.begin(js[0]));
    assert.equal(f.begins(), 2);
    f.owner(undefined);
    const physical: PhysicalCandidate = {
      generation: js[0].generation,
      nativePhysicalIdentity: js[0].generation,
      nativeId: 1,
      createdAt: "2026-10-06T01:02:03.123456789Z",
      ...codexOAuthProfile,
    };
    f.mappings.set(f.scopeKey(f.context, js[0].generation), {
      ...js[0],
      descriptor: { ...physical, nativePhysicalIdentity: randomUUID() },
    });
    assert.equal((await f.callback("oauth-owner-authority", lookup(js[0]))).status, 403);
    f.mappings.delete(f.scopeKey(f.context, js[0].generation));
    f.control.bearers.replace([]);
    assert.equal((await f.callback("oauth-owner-authority", lookup(js[0]))).status, 403);
    await assert.rejects(fixed.begin(js[0]));
    assert.equal(f.begins(), 2);
  } finally {
    await f.close();
  }
});

// RED if completion switches owner/journal, repeats a spent handoff, reflects
// callback material, or replays after a lost ACK while native still reads prepared.
test("source HTTP: sensitive SDK completion pins original owner and journal, then becomes readback only", async () => {
  const f = await sourceHTTP(true);
  try {
    f.connect("prepared");
    const sdk = createManagementClient({
      role: "management",
      origin: f.facadeOrigin,
      token: "source-public-management",
    });
    const operationId = randomUUID(),
      state = "a".repeat(64),
      code = "fixture+code/é" + "x".repeat(4081);
    const begun = await sdk.beginOAuth({
      operationId,
      ownerRef: "owner-one",
      profileId: codexOAuthProfile.profile,
      displayName: "Fixture",
    });
    const j = f.journals.get(f.scopeKey(f.context, operationId))!;
    const callbackURL =
      "http://localhost:1455/auth/callback?code=" +
      encodeURIComponent(code) +
      "&state=" +
      state +
      "&scope=openid+profile";
    const input = { operationId, ownerRef: "owner-one", callbackURL };
    const denied = await f.publicCall("/v1/accounts/oauth/complete", {
      ...input,
      ownerRef: "owner-two",
    });
    assert.equal(denied.status, 403);
    assert.equal(f.completions(), 0);
    const malformed = await f.publicCall("/v1/accounts/oauth/complete", {
      ...input,
      callbackURL: callbackURL + "&code=second",
    });
    assert.equal(malformed.status, 400);
    assert.equal(f.completions(), 0);
    // Public completion has its own bound even with a 4096-byte inference cap.
    assert.equal(Buffer.byteLength(code), 4096);
    assert.ok(Buffer.byteLength(JSON.stringify(input)) > 4096);
    const oversized = await fetch(f.facadeOrigin + "/v1/accounts/oauth/complete", {
      method: "POST",
      headers: {
        authorization: "Bearer source-public-management",
        "content-type": "application/json",
      },
      body: JSON.stringify(input) + " ".repeat(32_768),
    });
    assert.equal(oversized.status, 400);
    assert.equal(f.completions(), 0);
    await oversized.body?.cancel();
    const completed = await sdk.completeOAuth(input);
    assert.deepEqual(completed, begun.operation);
    assert.equal(f.completions(), 1);
    assert.equal(f.begins(), 1);
    assert.deepEqual(
      f.seen.find((s) => s.path === "POST /private/native/v1/oauth/connect/complete")?.tuple,
      {
        operation: operationId,
        owner_ref: j.ownerRef,
        account_ref: j.accountRef,
        generation: j.generation,
        state,
        code,
      },
    );
    assert.equal(JSON.stringify(completed).includes(code), false);
    assert.equal(JSON.stringify(completed).includes(state), false);
    assert.deepEqual(await sdk.completeOAuth(input), completed);
    assert.equal(f.completions(), 1);
    f.connect("entered");
    assert.deepEqual(await sdk.completeOAuth(input), completed);
    assert.equal(f.completions(), 1);
    f.operations.get(f.scopeKey(f.context, operationId))!.state = "unknown";
    const before = f.seen.length;
    const unknown = await sdk.completeOAuth(input);
    assert.equal(unknown.state, "unknown");
    assert.equal(f.seen.length, before);
    assert.equal(f.completions(), 1);
    const another = randomUUID();
    f.connect("prepared", true);
    await sdk.beginOAuth({
      operationId: another,
      ownerRef: "owner-one",
      profileId: codexOAuthProfile.profile,
      displayName: "Lost ACK fixture",
    });
    const lost = await sdk.completeOAuth({ ...input, operationId: another });
    assert.equal(lost.state, "unknown");
    assert.equal(f.completions(), 2);
    f.connect("prepared");
    const spentReads = f.seen.length;
    const replay = await sdk.completeOAuth({ ...input, operationId: another });
    assert.equal(replay.operationRef, lost.operationRef);
    assert.equal(replay.state, "unknown");
    assert.ok(replay.state === "unknown");
    assert.equal(replay.error?.effect, "effect_unknown");
    assert.equal(f.seen.length, spentReads);
    assert.equal(f.completions(), 2);
    assert.equal(
      JSON.stringify([lost, await malformed.json(), await denied.json()]).includes(state),
      false,
    );
    assert.equal(
      JSON.stringify([...f.journals.values(), ...f.operations.values()]).includes(callbackURL),
      false,
    );
    f.control.bearers.replace([]);
    assert.equal((await f.publicCall("/v1/accounts/oauth/complete", input)).status, 401);
    assert.equal(f.completions(), 2);
  } finally {
    await f.close();
  }
});

test("source HTTP: strict fixed POST descriptor readback keeps custody pending and pins physical birth", async () => {
  const f = await sourceHTTP(true);
  try {
    const operationId = randomUUID();
    const begun = await f.publicCall("/v1/accounts/oauth/begin", {
      operationId,
      ownerRef: "owner-one",
      profileId: codexOAuthProfile.profile,
      displayName: "Fixture",
    });
    assert.equal(begun.status, 202);
    const j = f.journals.get(f.scopeKey(f.context, operationId))!;
    const native = {
      account_id: 1,
      generation: j.generation,
      created_at: "2026-10-06T01:02:03.123456789Z",
      profile: codexOAuthProfile.profile,
      base_url: codexOAuthProfile.baseURL,
      model: codexOAuthProfile.model,
    };
    const reply = {
      operation: operationId,
      account_ref: j.accountRef,
      state: "staged",
      qualification: "controlled-source-v1",
      native,
    };
    const client = new NativeOAuthEnrollmentClient({
      origin: f.origin,
      consumerId: j.consumerId,
      controlCredential: f.consumer.managementCredential,
      ownerRef: j.ownerRef,
      deadlineMs: 75,
    });
    f.descriptor(reply);
    const d = await client.describe(j);
    assert.equal(d.state, "qualified");
    if (d.state === "qualified") {
      assert.equal(d.native.createdAt, native.created_at);
      assert.equal(d.native.nativePhysicalIdentity, j.generation);
    }
    for (const value of [
      { ...reply, operation: randomUUID() },
      { ...reply, account_ref: randomUUID() },
      { ...reply, token: "forbidden" },
      { ...reply, state: "staged", qualification: "pending" },
      { ...reply, native: { ...native, generation: randomUUID() } },
      { ...reply, native: { ...native, profile: f.secondProfile.profile } },
      { ...reply, native: { ...native, base_url: f.secondProfile.baseURL } },
      { ...reply, native: { ...native, model: f.secondProfile.model } },
      { ...reply, native: { ...native, account_id: Number.MAX_SAFE_INTEGER + 1 } },
    ]) {
      f.descriptor(value);
      await assert.rejects(
        client.describe(j),
        (e) => e instanceof NativeFailure && e.code === "invalid_readback",
      );
    }
    for (const mode of ["redirect", "overflow", "headers", "utf8", "timeout"] as const) {
      f.descriptor(undefined, mode);
      await assert.rejects(
        client.describe(j),
        (e) =>
          e instanceof NativeFailure &&
          (mode !== "headers" || (e.code === "bounded" && e.classification === "uncertain")),
        mode,
      );
    }
    assert.equal(
      f.seen.some((s) => s.path.includes("/escaped")),
      false,
    );
    f.descriptor(undefined);
    const pending = await f.publicCall("/v1/operations/" + operationId);
    assert.equal(pending.status, 200);
    assert.equal(((await pending.json()) as { state: string }).state, "pending");
    assert.equal(f.mappings.size, 0);
    assert.equal((await f.kernel.account(f.context, j.accountRef)).state, "staging");
    const before = f.seen.length;
    assert.equal(
      (await f.publicCall("/v1/operations/" + operationId + "?owner=owner-two")).status,
      400,
    );
    assert.equal(f.seen.length, before);
    // Protected source proof promotes only kernel state; no generic route read
    // or physical OAuth activation belongs to this account lifecycle.
    f.descriptor(reply);
    f.nativeRows.set(j.generation, { descriptor: native, state: "inactive" });
    const qualified = await f.publicCall("/v1/operations/" + operationId);
    assert.equal(qualified.status, 200);
    assert.equal(((await qualified.json()) as { state: string }).state, "applied");
    assert.equal((await f.kernel.account(f.context, j.accountRef)).state, "active");
    assert.equal(
      (await f.store.mapping(f.context, j.generation))?.descriptor.createdAt,
      native.created_at,
    );
    assert.equal(f.nativeRows.get(j.generation)?.state, "inactive");
    assert.equal(
      f.seen.some((s) => s.path.includes("/candidates")),
      false,
    );
    const secondId = randomUUID();
    f.descriptor(undefined);
    assert.equal(
      (
        await f.publicCall("/v1/accounts/oauth/begin", {
          operationId: secondId,
          ownerRef: "owner-two",
          profileId: codexOAuthProfile.profile,
          displayName: "Fixture",
        })
      ).status,
      202,
    );
    const second = f.journals.get(f.scopeKey(f.context, secondId))!;
    const secondNative = { ...native, account_id: 2, generation: second.generation };
    f.descriptor({
      ...reply,
      operation: secondId,
      account_ref: second.accountRef,
      native: { ...secondNative, generation: randomUUID() },
    });
    const mismatched = await f.publicCall("/v1/operations/" + secondId);
    assert.equal(mismatched.status, 200);
    assert.equal(((await mismatched.json()) as { state: string }).state, "pending");
    assert.equal(await f.store.mapping(f.context, second.generation), undefined);
  } finally {
    await f.close();
  }
});

test("source HTTP: same fenced original remints only scoped readback and close, never dispatch", async () => {
  const f = await sourceHTTP(false);
  try {
    const creationId = randomUUID();
    const created = await f.publicCall("/v1/accounts", {
      operationId: creationId,
      ownerRef: "owner-one",
      profileId: f.secondProfile.profile,
      displayName: "Fenced fixture",
      credential: { kind: "api_key", value: "fixture-write-only" },
    });
    assert.equal(created.status, 200);
    const accountRef = f.journals.get(f.scopeKey(f.context, creationId))!.accountRef;
    const input = {
      operationId: randomUUID(),
      invocationRef: "source-fenced-original",
      attemptRef: "attempt",
      accountRefs: [accountRef],
      profileId: f.secondProfile.profile,
      subjectRef: "source-subject",
      policyRevision: 1,
      bindingRevision: 1,
      limits: f.secondProfile.limits,
      deadline: new Date(Date.now() + 10_000).toISOString(),
    };
    const mint = () => f.publicCall("/internal/v1/run-access", input, "source-public-run");
    const first = await mint();
    assert.equal(first.status, 200);
    type Access = {
      operation: { operationRef: string; result: { executionRef: string; state: string } };
      bearer: string;
      admission: Record<string, unknown>;
    };
    const run = (await first.json()) as Access,
      ref = run.operation.result.executionRef;
    const executionKey = f.scopeKey(f.context, ref),
      original = await f.kernel.savedExecution(f.context, ref);
    const requestId = randomUUID(),
      requestKey = f.scopeKey(f.context, ref + ":" + requestId);
    // Committed accepted effect after fencing/occupancy closure; SQL closure is
    // independently qualified elsewhere. This source fixture makes no native call.
    f.requests.set(requestKey, { requestRef: requestId, effect: "effect_unknown" });
    const fenced: SavedExecution = { ...original, state: "fenced", dispatchAllowed: false };
    f.executions.set(executionKey, fenced);
    const nativeCalls = f.seen.length,
      forwarded = f.forwarded.length;
    const denyDispatch = async (bearer: string, admission: Record<string, unknown>) => {
      for (const id of [requestId, randomUUID()]) {
        const response = await f.publicCall(
          "/v1/executions/" + ref + "/requests",
          {
            model: f.secondProfile.model,
            stream: true,
            store: false,
            service_tier: "default",
            input: "fixture",
          },
          bearer,
          { "x-gateway-admission": JSON.stringify(admission), "x-gateway-request-id": id },
        );
        assert.equal(response.status, 403);
        assert.equal(((await response.json()) as { effect: string }).effect, "not_dispatched");
        assert.equal(f.seen.length, nativeCalls);
        assert.equal(f.forwarded.length, forwarded);
      }
      assert.deepEqual(f.requests.get(requestKey), {
        requestRef: requestId,
        effect: "effect_unknown",
      });
      assert.equal(f.requests.size, 1);
    };
    await denyDispatch(run.bearer, run.admission);
    const retained = await mint();
    assert.equal(retained.status, 200, "same fenced original must retain scoped access");
    assert.equal(((await retained.json()) as Access).bearer, run.bearer);
    // Lose the issued execution mapping while keeping current configured policy.
    f.control.bearers.replace(f.cfg.bearers);
    const remint = await mint();
    assert.equal(remint.status, 200, "same fenced original must receive scoped access");
    const scoped = (await remint.json()) as Access;
    assert.equal(scoped.operation.operationRef, input.operationId);
    assert.deepEqual(scoped.operation.result, {
      kind: "execution",
      executionRef: ref,
      accountRef,
      authorizationEpoch: original.admission.authorizationEpoch,
      deadline: input.deadline,
      state: "fenced",
    });
    assert.deepEqual(scoped.admission, run.admission);
    assert.notEqual(scoped.bearer, run.bearer);
    const grant = f.control.bearers.resolve(scoped.bearer);
    assert.ok(grant && grant.role === "execution");
    assert.equal(grant.saved.generation, original.generation);
    assert.deepEqual(grant.saved.admission, original.admission);
    const repeated = await mint();
    assert.equal(repeated.status, 200);
    assert.equal(((await repeated.json()) as Access).bearer, scoped.bearer);
    for (const path of ["/v1/executions/" + ref, "/v1/operations/" + input.operationId]) {
      const read = await f.publicCall(path, undefined, scoped.bearer);
      assert.equal(read.status, 200);
      const dto = (await read.json()) as { state: string; result?: { state: string } };
      assert.equal(dto.result?.state ?? dto.state, "fenced");
    }
    const status = await f.publicCall(
      "/v1/executions/" + ref + "/requests/" + requestId,
      undefined,
      scoped.bearer,
      { accept: "application/json" },
    );
    assert.equal(status.status, 200);
    assert.equal(((await status.json()) as { effect: string }).effect, "effect_unknown");
    const foreign = await f.publicCall("/v1/executions/" + randomUUID(), undefined, scoped.bearer);
    assert.equal(foreign.status, 403);
    const foreignOperation = await f.publicCall(
      "/v1/operations/" + creationId,
      undefined,
      scoped.bearer,
    );
    assert.equal(foreignOperation.status, 403);
    await denyDispatch(scoped.bearer, scoped.admission);
    const changed = await f.publicCall(
      "/internal/v1/run-access",
      { ...input, invocationRef: "changed-intent" },
      "source-public-run",
    );
    assert.equal(changed.status, 409);
    const prepare = f.kernel.prepare;
    // Simulate inconsistent persisted readback across the two server reads.
    for (const conflicting of [
      { ...fenced, generation: randomUUID() },
      { ...fenced, admission: { ...fenced.admission, issuerEpoch: randomUUID() } },
      {
        ...fenced,
        admission: {
          ...fenced.admission,
          authorizationEpoch: fenced.admission.authorizationEpoch + 1,
        },
      },
    ]) {
      f.control.bearers.replace(f.cfg.bearers);
      f.kernel.prepare = async (...args) => {
        const op = await prepare(...args);
        f.executions.set(executionKey, conflicting);
        return op;
      };
      assert.equal((await mint()).status, 403);
      f.executions.set(executionKey, fenced);
    }
    // Even an applied prepare cannot supply the exception without the original lookup.
    const operation = f.kernel.operation;
    f.kernel.operation = async (context, id) => {
      if (id === input.operationId) throw new KernelError("unknown");
      return operation(context, id);
    };
    f.kernel.prepare = prepare;
    assert.equal((await mint()).status, 403);
    f.kernel.operation = operation;
    // Current owner authorization and captured grant replacement still deny issuance.
    const account = f.accounts.get(f.scopeKey(f.context, accountRef))!;
    account.ownerRef = "foreign-owner";
    assert.equal((await mint()).status, 403);
    account.ownerRef = "owner-one";
    f.kernel.prepare = async (...args) => {
      const op = await prepare(...args);
      f.control.bearers.replace(f.cfg.bearers);
      return op;
    };
    assert.equal((await mint()).status, 403);
    f.kernel.prepare = prepare;
    const currentIssuer = f.kernel.issuer;
    f.kernel.issuer = async (...args) => {
      const current = await currentIssuer(...args);
      f.control.bearers.replace(f.cfg.bearers);
      return current;
    };
    assert.equal(
      (await mint()).status,
      403,
      "grant replacement during current issuer proof denies issuance",
    );
    f.kernel.issuer = currentIssuer;
    f.executions.set(executionKey, {
      ...fenced,
      admission: { ...fenced.admission, expiresAt: new Date(0).toISOString() },
    });
    assert.equal((await mint()).status, 403, "original expiry still denies remint");
    f.executions.set(executionKey, fenced);
    const finalAccess = await mint();
    assert.equal(finalAccess.status, 200);
    const final = (await finalAccess.json()) as Access;
    const closeId = randomUUID(),
      close = await f.publicCall(
        "/v1/executions/" + ref + "/close",
        { operationId: closeId, reason: "cancelled" },
        final.bearer,
      );
    assert.equal(close.status, 200);
    assert.deepEqual(await close.json(), { operationRef: closeId, state: "applied" });
    assert.deepEqual(await f.kernel.savedExecution(f.context, ref), fenced);
    assert.ok(f.executionCleanup.has(executionKey));
    const closeRead = await f.publicCall("/v1/operations/" + closeId, undefined, final.bearer);
    assert.equal(closeRead.status, 200);
    assert.deepEqual(await closeRead.json(), { operationRef: closeId, state: "applied" });
    const afterClose = await mint();
    assert.equal(afterClose.status, 200, "close of fenced original retains scoped readback");
    const retainedAfterClose = (await afterClose.json()) as Access;
    assert.equal(retainedAfterClose.bearer, final.bearer);
    assert.equal(retainedAfterClose.operation.result.state, "fenced");
    const afterCloseStatus = await f.publicCall(
      "/v1/executions/" + ref + "/requests/" + requestId,
      undefined,
      final.bearer,
      { accept: "application/json" },
    );
    assert.equal(afterCloseStatus.status, 200);
    assert.equal(((await afterCloseStatus.json()) as { effect: string }).effect, "effect_unknown");
    assert.equal(
      (await f.publicCall("/v1/executions/" + randomUUID(), undefined, final.bearer)).status,
      403,
    );
    await denyDispatch(final.bearer, final.admission);

    // A distinct row actually closed from open still denies identical remint.
    const closedInput = {
      ...input,
      operationId: randomUUID(),
      invocationRef: "source-closed-original",
    };
    const closedMint = () =>
      f.publicCall("/internal/v1/run-access", closedInput, "source-public-run");
    const openReply = await closedMint();
    assert.equal(openReply.status, 200);
    const open = (await openReply.json()) as Access,
      closedRef = open.operation.result.executionRef;
    const closedOriginal = await f.kernel.savedExecution(f.context, closedRef);
    const closedReply = await f.publicCall(
      "/v1/executions/" + closedRef + "/close",
      { operationId: randomUUID(), reason: "completed" },
      open.bearer,
    );
    assert.equal(closedReply.status, 200);
    assert.equal((await f.kernel.savedExecution(f.context, closedRef)).state, "closed");
    const closedDenied = await closedMint();
    assert.equal(closedDenied.status, 403);
    assert.equal(((await closedDenied.json()) as { effect: string }).effect, "effect_unknown");

    // Restore between the final saved read and issuance must be observed by a
    // fresh server issuer proof, even though exact prepare accepts the old HMAC.
    f.control.bearers.replace(f.cfg.bearers);
    const savedExecution = f.kernel.savedExecution,
      freshIssuer = randomUUID();
    let reads = 0;
    f.kernel.savedExecution = async (...args) => {
      const saved = await savedExecution(...args);
      if (++reads === 2)
        await f.kernel.restore(f.context, original.admission.issuerEpoch, freshIssuer);
      return saved;
    };
    const restoredDenied = await mint();
    assert.equal(restoredDenied.status, 403);
    assert.equal(((await restoredDenied.json()) as { effect: string }).effect, "effect_unknown");
    f.kernel.savedExecution = savedExecution;
    assert.equal(await f.kernel.issuer(f.context), freshIssuer);
    const restoredClosed = await f.kernel.savedExecution(f.context, closedRef);
    assert.equal(restoredClosed.state, "fenced");
    assert.equal(restoredClosed.generation, closedOriginal.generation);
    assert.deepEqual(restoredClosed.admission, closedOriginal.admission);
    const restoredClosedDenied = await closedMint();
    assert.equal(restoredClosedDenied.status, 403);
    assert.equal(
      ((await restoredClosedDenied.json()) as { effect: string }).effect,
      "effect_unknown",
    );
    assert.equal(f.executions.size, 2);
    assert.equal(f.seen.length, nativeCalls);
  } finally {
    await f.close();
  }
});

test("source HTTP: explicit management profile capability denies same-owner MiMo before effects and permits OpenRouter", async () => {
  const f = await sourceHTTP(false);
  try {
    const initial = f.cfg.bearers.find((b) => b.role === "management");
    assert.ok(initial && initial.role === "management");
    assert.equal(initial.preparation.profileId, f.profile.profile);
    const restricted = {
      ...initial,
      ownerRefs: ["owner-one"],
      profileIds: [f.secondProfile.profile],
    };
    f.control.bearers.replace([
      restricted,
      ...f.cfg.bearers.filter((b) => b.role === "run-control"),
    ]);
    let creates = 0,
      mutations = 0;
    const create = f.control.management.create.bind(f.control.management),
      begin = f.kernel.beginAccount.bind(f.kernel);
    f.control.management.create = async (...args) => {
      creates++;
      return create(...args);
    };
    f.kernel.beginAccount = async (...args) => {
      mutations++;
      return begin(...args);
    };
    const connect = (profileId: string, ownerRef = "owner-one") =>
      f.publicCall("/v1/accounts", {
        operationId: randomUUID(),
        ownerRef,
        profileId,
        displayName: "Fixture",
        credential: { kind: "api_key", value: "fixture-write-only" },
      });
    const forbidden = await connect(f.profile.profile);
    assert.equal(
      forbidden.status,
      403,
      "same-owner MiMo denied before effects; managementCreates=" +
        creates +
        " nativeCreates=" +
        f.seen.filter((r) => r.path === "POST /private/native/v1/candidates").length,
    );
    assert.equal(creates, 0);
    assert.equal(mutations, 0);
    assert.equal(f.seen.length, 0);
    assert.equal(f.journals.size, 0);
    assert.equal(
      (await connect(f.secondProfile.profile, "owner-two")).status,
      403,
      "permitted profile cannot upgrade owner authority",
    );
    assert.equal(creates, 0);
    assert.equal(mutations, 0);
    const allowed = await connect(f.secondProfile.profile);
    assert.equal(allowed.status, 200);
    const op = (await allowed.json()) as { operationRef: string; result: { accountRef: string } };
    assert.equal(creates, 1);
    assert.equal(mutations, 1);
    assert.equal(f.seen.filter((r) => r.path === "POST /private/native/v1/candidates").length, 1);
    const accountRef = op.result.accountRef;
    // Fixture-owned rows pin ordering so filtering cannot silently refill a page
    // or substitute its cursor, and the foreign owner remains excluded by the kernel.
    const foreignProfile = "00000000-0000-4000-8000-000000000001",
      foreignOwner = "00000000-0000-4000-8000-000000000002";
    const seed = (ref: string, ownerRef: string, profile: string) =>
      f.accounts.set(f.scopeKey(f.context, ref), {
        accountRef: ref,
        ownerRef,
        profile,
        displayName: "Fixture",
        state: "active",
        revision: 1,
        epoch: 1,
      });
    seed(foreignProfile, "owner-one", f.profile.profile);
    seed(foreignOwner, "owner-two", f.secondProfile.profile);
    assert.equal((await f.publicCall("/v1/accounts/" + foreignProfile)).status, 403);
    assert.equal((await f.publicCall("/v1/accounts/" + foreignOwner)).status, 403);
    assert.equal((await f.publicCall("/v1/accounts/" + accountRef)).status, 200);
    const catalog = await f.publicCall("/v1/profiles");
    assert.equal(catalog.status, 200);
    assert.deepEqual(
      ((await catalog.json()) as { profiles: { profileId: string }[] }).profiles.map(
        (p) => p.profileId,
      ),
      [f.secondProfile.profile],
    );
    const list = await f.publicCall("/v1/accounts?limit=1");
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), { accounts: [], nextCursor: foreignProfile });
    const next = await f.publicCall("/v1/accounts?limit=1&cursor=" + foreignProfile);
    assert.equal(next.status, 200);
    assert.deepEqual(
      ((await next.json()) as { accounts: { accountRef: string }[] }).accounts.map(
        (a) => a.accountRef,
      ),
      [accountRef],
    );
    assert.equal((await f.publicCall("/v1/accounts?ownerRef=owner-two")).status, 403);
    const named = (
      ref: string,
      kind: "rename" | "reconnect" | "disable",
      expectedMetadataRevision = 1,
    ) =>
      fetch(f.facadeOrigin + "/v1/accounts/" + ref + (kind === "rename" ? "" : "/" + kind), {
        method: kind === "rename" ? "PATCH" : "POST",
        headers: {
          authorization: "Bearer " + restricted.token,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          operationId: randomUUID(),
          expectedMetadataRevision,
          ...(kind === "rename"
            ? { displayName: "Renamed" }
            : kind === "reconnect"
              ? { credential: { kind: "api_key", value: "fixture-write-only" } }
              : {}),
        }),
      });
    const beforeNative = f.seen.length;
    for (const kind of ["rename", "reconnect", "disable"] as const) {
      assert.equal((await named(foreignProfile, kind)).status, 403);
      assert.equal((await named(foreignOwner, kind)).status, 403);
    }
    assert.equal(mutations, 1);
    assert.equal(f.seen.length, beforeNative);
    assert.equal((await named(accountRef, "rename")).status, 200);
    const renamed = await f.publicCall("/v1/accounts/" + accountRef);
    assert.equal(((await renamed.json()) as { displayName: string }).displayName, "Renamed");
    const reconnected = await named(accountRef, "reconnect", 2);
    assert.equal(reconnected.status, 200);
    const reconnectOp = (await reconnected.json()) as {
      result: { metadataRevision: number; authorizationEpoch: number };
    };
    assert.equal(reconnectOp.result.metadataRevision, 3);
    assert.equal(reconnectOp.result.authorizationEpoch, 2);
    assert.equal(f.seen.filter((r) => r.path === "POST /private/native/v1/candidates").length, 2);
    const active = (await (await f.publicCall("/v1/accounts/" + accountRef)).json()) as {
      state: string;
      metadataRevision: number;
      authorizationEpoch: number;
    };
    assert.equal(active.state, "active");
    assert.equal(active.metadataRevision, 3);
    assert.equal(active.authorizationEpoch, 2);
    const beforeStaleNative = f.seen.length,
      beforeStaleOperations = f.operations.size;
    assert.equal((await named(accountRef, "disable", 2)).status, 409);
    assert.equal(mutations, 4);
    assert.equal(f.seen.length, beforeStaleNative);
    assert.equal(f.operations.size, beforeStaleOperations);
    assert.deepEqual(await (await f.publicCall("/v1/accounts/" + accountRef)).json(), active);
    assert.equal((await named(accountRef, "disable", 3)).status, 200);
    assert.equal(mutations, 5);
    assert.equal(
      (await f.publicCall("/v1/operations/" + op.operationRef)).status,
      200,
      "accepted operation readback survives",
    );
    // Removing the opt-in retains both configured API-key profiles under one
    // token whose preparation remains MiMo, just like the existing RR caller.
    f.control.bearers.replace(f.cfg.bearers);
    const broad = await f.publicCall("/v1/profiles");
    assert.equal(broad.status, 200);
    assert.deepEqual(
      ((await broad.json()) as { profiles: { profileId: string }[] }).profiles.map(
        (p) => p.profileId,
      ),
      [f.profile.profile, f.secondProfile.profile],
    );
    const broadCreate = await connect(f.profile.profile);
    assert.equal(broadCreate.status, 200);
    const accepted = (await broadCreate.json()) as {
      operationRef: string;
      result: { accountRef: string };
    };
    f.control.bearers.replace([restricted]);
    assert.equal((await f.publicCall("/v1/accounts/" + accepted.result.accountRef)).status, 403);
    assert.equal(
      (await f.publicCall("/v1/operations/" + accepted.operationRef)).status,
      200,
      "narrowing retains accepted operation readback",
    );
  } finally {
    await f.close();
  }
});

// Red if an output envelope bypasses selected-profile admission, widens any
// other limit, or changes the immutable cap of an already captured execution.
test("source HTTP: consumer output envelope preserves physical and historical admission caps", async () => {
  const f = await sourceHTTP(true, true);
  try {
    const profiles = captureServiceProfiles(f.cfg),
      token = "source-output-envelope";
    const control = {
      role: "consumer-control" as const,
      consumerId: f.context.consumerId,
      token,
      profileIds: profiles.map((p) => p.profile),
      limits: { ...f.profile.limits, outputBytes: 8_388_608 },
      maxRunMs: 21_600_000,
    };
    // Exercise the startup capture boundary and actual facade, not just a
    // permissive hand-created bearer registry.
    const captured = captureServiceBearers([control], f.context.consumerId, profiles);
    f.control.bearers.replace(captured);
    const prepare = (profileId: string, accountRef: string, outputBytes: number) => ({
      operationId: randomUUID(),
      invocationRef: randomUUID(),
      attemptRef: "attempt",
      accountRefs: [accountRef],
      profileId,
      subjectRef: "source-subject",
      policyRevision: 1,
      bindingRevision: 1,
      limits: { ...f.profile.limits, outputBytes },
      deadline: new Date(Date.now() + 60_000).toISOString(),
    });
    type Access = {
      operation: { result: { executionRef: string } };
      bearer: string;
      admission: { limits: typeof control.limits };
    };
    let historic: Access | undefined;
    for (const p of profiles) {
      // Explicit fixture-owned committed account/mapping state; no provider or
      // OAuth credentials are used to test the policy admission boundary.
      const accountRef = randomUUID(),
        generation = randomUUID();
      f.accounts.set(f.scopeKey(f.context, accountRef), {
        accountRef,
        ownerRef: "owner-one",
        profile: p.profile,
        displayName: "Synthetic budget",
        state: "active",
        revision: 1,
        epoch: 1,
      });
      f.mappings.set(f.scopeKey(f.context, generation), {
        consumerId: f.context.consumerId,
        operationId: randomUUID(),
        accountRef,
        ownerRef: "owner-one",
        purpose: "create",
        generation,
        worker: randomUUID(),
        profile: p,
        descriptor: {
          generation,
          nativePhysicalIdentity: generation,
          nativeId: 1,
          createdAt: "2026-10-06T01:02:03Z",
          profile: p.profile,
          baseURL: p.baseURL,
          model: p.model,
        },
      });
      const input = prepare(p.profile, accountRef, p.limits.outputBytes);
      const before = f.executions.size;
      const denied = await f.publicCall(
        "/internal/v1/run-access",
        { ...input, limits: { ...input.limits, outputBytes: p.limits.outputBytes + 1 } },
        token,
      );
      assert.ok([400, 403].includes(denied.status));
      assert.equal(f.executions.size, before);
      for (const field of ["requests", "concurrency", "requestBytes", "tokens"] as const) {
        const rejected = await f.publicCall(
          "/internal/v1/run-access",
          { ...input, limits: { ...input.limits, [field]: input.limits[field] + 1 } },
          token,
        );
        assert.equal(rejected.status, 403);
        assert.equal(f.executions.size, before);
      }
      const accepted = await f.publicCall("/internal/v1/run-access", input, token);
      assert.equal(accepted.status, 200);
      const access = (await accepted.json()) as Access;
      assert.deepEqual(access.admission.limits, p.limits);
      if (p.profile === f.profile.profile) historic = access;
      assert.equal(f.forwarded.length, 0, "admission never dispatches");
    }
    assert.ok(historic);
    const ref = historic.operation.result.executionRef,
      saved = await f.kernel.savedExecution(f.context, ref);
    assert.equal(saved.admission.limits.outputBytes, 1_048_576);
    const initial = f.cfg.bearers[0];
    assert.equal(initial.role, "management");
    const management = {
      ...initial,
      preparation: {
        ...initial.preparation,
        accountRefs: [saved.admission.accountRef],
        profileId: f.profile.profile,
        limits: control.limits,
      },
    };
    f.control.bearers.replace([
      ...captured,
      management,
      { role: "execution", consumerId: f.context.consumerId, token: historic.bearer, saved },
    ]);
    const count = f.executions.size;
    const direct = await f.publicCall(
      "/v1/executions",
      prepare(f.profile.profile, saved.admission.accountRef, 1_048_577),
    );
    assert.equal(direct.status, 403);
    assert.equal(f.executions.size, count);
    assert.equal(f.forwarded.length, 0);
    const body = {
      model: f.profile.model,
      stream: true,
      store: false,
      service_tier: "default",
      input: "fixture",
    };
    const request = (admission: Access["admission"]) =>
      f.publicCall("/v1/executions/" + ref + "/requests", body, historic!.bearer, {
        "x-gateway-request-id": randomUUID(),
        "x-gateway-admission": JSON.stringify(admission),
      });
    const widened = await request({
      ...historic.admission,
      limits: { ...historic.admission.limits, outputBytes: 8_388_608 },
    });
    assert.equal(widened.status, 403);
    assert.equal(f.forwarded.length, 0);
    // A matching stored admission and execution bearer must still be rechecked
    // against the current selected physical profile before native transport.
    const oversized = {
      ...saved,
      admission: {
        ...saved.admission,
        limits: { ...saved.admission.limits, outputBytes: 1_048_577 },
      },
    };
    f.executions.set(f.scopeKey(f.context, ref), oversized);
    f.control.bearers.replace([
      {
        role: "execution",
        consumerId: f.context.consumerId,
        token: historic.bearer,
        saved: oversized,
      },
    ]);
    assert.equal(
      (await request({ ...historic.admission, limits: oversized.admission.limits })).status,
      403,
    );
    assert.equal(f.forwarded.length, 0);
    f.executions.set(f.scopeKey(f.context, ref), saved);
    f.control.bearers.replace([
      { role: "execution", consumerId: f.context.consumerId, token: historic.bearer, saved },
    ]);
    f.responseBytes(1_048_576);
    const exact = await request(historic.admission);
    assert.equal(exact.status, 200);
    assert.equal((await exact.arrayBuffer()).byteLength, 1_048_576);
    f.responseBytes(1_048_577);
    const overflow = await request(historic.admission);
    assert.equal(overflow.status, 200);
    await assert.rejects(
      overflow.arrayBuffer(),
      "historical admission still enforces its one MiB stream cap",
    );
    assert.deepEqual(await f.kernel.savedExecution(f.context, ref), saved);
  } finally {
    await f.close();
  }
});

test("source HTTP: simultaneous finite tuples create/read/admit/forward independently and reject cross-profile authority", async () => {
  const f = await sourceHTTP(false);
  try {
    const catalog = await f.publicCall("/v1/profiles");
    assert.equal(catalog.status, 200);
    assert.deepEqual(
      ((await catalog.json()) as { profiles: { profileId: string }[] }).profiles.map(
        (p) => p.profileId,
      ),
      [f.profile.profile, f.secondProfile.profile],
    );
    for (const [i, p] of [f.profile, f.secondProfile].entries()) {
      const token = "source-public-management";
      const operationId = randomUUID(),
        response = await f.publicCall(
          "/v1/accounts",
          {
            operationId,
            ownerRef: "owner-one",
            profileId: p.profile,
            displayName: "Fixture",
            credential: { kind: "api_key", value: "fixture-write-only" },
          },
          token,
        );
      assert.equal(response.status, 200);
      const j = f.journals.get(f.scopeKey(f.context, operationId))!,
        mapping = await f.store.mapping(f.context, j.generation);
      assert.ok(mapping);
      assert.equal(mapping.descriptor.profile, p.profile);
      assert.equal(mapping.descriptor.baseURL, p.baseURL);
      assert.equal(mapping.descriptor.model, p.model);
      const input = {
        operationId: randomUUID(),
        invocationRef: "source-invocation-" + i,
        attemptRef: "attempt",
        accountRefs: [j.accountRef],
        profileId: p.profile,
        subjectRef: "source-subject",
        policyRevision: 1,
        bindingRevision: 1,
        limits: f.secondProfile.limits,
        deadline: new Date(Date.now() + 10_000).toISOString(),
      };
      const access = await f.publicCall("/internal/v1/run-access", input, "source-public-run");
      assert.equal(access.status, 200);
      const run = (await access.json()) as {
        operation: { result: { executionRef: string } };
        bearer: string;
        admission: Record<string, unknown>;
      };
      const executionRef = run.operation.result.executionRef;
      const headers = {
        "x-gateway-admission": JSON.stringify(run.admission),
        "x-gateway-request-id": randomUUID(),
      };
      const body = {
        model: p.model,
        stream: true,
        store: false,
        service_tier: "default",
        input: [{ role: "user", content: "fixture tools and final" }],
      };
      const before = f.forwarded.length;
      const bad = await f.publicCall(
        "/v1/executions/" + executionRef + "/requests",
        { ...body, model: i ? f.profile.model : f.secondProfile.model },
        run.bearer,
        headers,
      );
      assert.equal(bad.status, 400);
      assert.equal(f.forwarded.length, before);
      // Corrupt each server mapping component before a fresh POST; none may
      // borrow the other profile's descriptor or qualification/limit policy.
      for (const patch of [
        { profile: { ...mapping.profile, qualificationRef: "wrong-receipt" } },
        {
          descriptor: {
            ...mapping.descriptor,
            baseURL: i ? f.profile.baseURL : f.secondProfile.baseURL,
          },
        },
        {
          descriptor: { ...mapping.descriptor, model: i ? f.profile.model : f.secondProfile.model },
        },
      ]) {
        f.mappings.set(f.scopeKey(f.context, j.generation), { ...mapping, ...patch });
        const deny = await f.publicCall(
          "/v1/executions/" + executionRef + "/requests",
          body,
          run.bearer,
          { ...headers, "x-gateway-request-id": randomUUID() },
        );
        assert.equal(deny.status, 403);
        assert.equal(f.forwarded.length, before);
      }
      f.mappings.set(f.scopeKey(f.context, j.generation), mapping);
      const completed = await f.publicCall(
        "/v1/executions/" + executionRef + "/requests",
        body,
        run.bearer,
        headers,
      );
      assert.equal(completed.status, 200);
      assert.match(await completed.text(), /tools-and-final/);
      assert.equal(f.forwarded.length, before + 1);
      assert.deepEqual(f.forwarded.at(-1), { profile: p.profile, baseURL: p.baseURL, body });
      assert.equal(
        (await f.kernel.request(f.context, executionRef, headers["x-gateway-request-id"])).effect,
        "completed",
      );
      const denied = await f.publicCall(
        "/internal/v1/run-access",
        {
          ...input,
          operationId: randomUUID(),
          limits: { ...input.limits, tokens: p.limits.tokens + 1 },
        },
        "source-public-run",
      );
      assert.equal(denied.status, 403);
      const noEndpoint = await f.publicCall(
        "/v1/accounts",
        {
          operationId: randomUUID(),
          ownerRef: "owner-one",
          profileId: p.profile,
          displayName: "Fixture",
          baseURL: p.baseURL,
          model: p.model,
          credential: { kind: "api_key", value: "fixture-write-only" },
        },
        token,
      );
      assert.equal(noEndpoint.status, 400);
    }
    assert.equal(f.forwarded.length, 2);
  } finally {
    await f.close();
  }
});

// Suspended OAuth may attest retained custody, but that purpose must not grant
// the existing enrollment or refresh authorities.
test("source HTTP: suspended OAuth custody purpose excludes enrollment and refresh", async () => {
  const f = await sourceHTTP(true);
  try {
    const operationId = randomUUID();
    assert.equal(
      (
        await f.publicCall("/v1/accounts/oauth/begin", {
          operationId,
          ownerRef: "owner-one",
          profileId: codexOAuthProfile.profile,
          displayName: "Custody fixture",
        })
      ).status,
      202,
    );
    const j = f.journals.get(f.scopeKey(f.context, operationId))!;
    const physical: PhysicalCandidate = {
      generation: j.generation,
      nativePhysicalIdentity: j.generation,
      nativeId: 42,
      createdAt: "2026-10-06T01:02:03.123456789Z",
      ...codexOAuthProfile,
    };
    f.mappings.set(f.scopeKey(f.context, j.generation), { ...j, descriptor: physical });
    const op = f.operations.get(f.scopeKey(f.context, operationId))!;
    op.state = "applied";
    const account = f.accounts.get(f.scopeKey(f.context, j.accountRef))!;
    account.state = "suspended";
    let generation = j.generation;
    f.kernel.accountCustody = async () => ({
      generation,
      nativePhysicalIdentity: generation,
      revision: account.revision,
      epoch: account.epoch,
    });
    const input = {
      consumerId: j.consumerId,
      operationId,
      accountRef: j.accountRef,
      generation: j.generation,
    };
    const custody = await f.callback("oauth-custody-authority", input);
    assert.equal(custody.status, 200);
    assert.deepEqual(await custody.json(), { ok: true, ownerRef: j.ownerRef });
    assert.equal((await f.callback("oauth-owner-authority", input)).status, 403);
    assert.equal((await f.callback("oauth-refresh-authority", input)).status, 403);
    generation = randomUUID();
    assert.equal((await f.callback("oauth-custody-authority", input)).status, 403);
    generation = j.generation;
    account.state = "disabled";
    assert.equal((await f.callback("oauth-custody-authority", input)).status, 403);
    account.state = "suspended";
    f.control.bearers.replace([]);
    assert.equal((await f.callback("oauth-custody-authority", input)).status, 403);
    assert.equal(f.forwarded.length, 0);
  } finally {
    await f.close();
  }
});

// Operation readback cannot enter enrollment recovery before lifecycle/owner
// authorization, even if the caller knows another owner's exact operation ID.
test("v2 lifecycle readback never recovers foreign or same-owner enrollment operations", async () => {
  const f = await sourceHTTP(true);
  const facade = createFacade({
    kernel: f.kernel,
    store: f.store,
    management: f.control.management,
    bearers: f.control.bearers,
    profiles: f.control.catalog,
    intentHmacKey: randomBytes(32),
    lifecycle: { contract: lifecycleWire.LIFECYCLE_CAPABILITY_CONTRACT, writeGate: "enabled" },
  });
  try {
    const pending: CandidateJournal[] = [];
    for (const ownerRef of ["owner-one", "owner-two"]) {
      const operationId = randomUUID();
      assert.equal(
        (
          await f.publicCall("/v1/accounts/oauth/begin", {
            operationId,
            ownerRef,
            profileId: codexOAuthProfile.profile,
            displayName: "Authorization fixture",
          })
        ).status,
        202,
      );
      pending.push(f.journals.get(f.scopeKey(f.context, operationId))!);
    }
    const grant = f.cfg.bearers[0];
    assert.equal(grant.role, "management");
    assert.ok(grant.role === "management");
    f.control.bearers.replace([{ ...grant, ownerRefs: ["owner-one"] }]);
    await new Promise<void>((resolve) => facade.listen(0, "127.0.0.1", resolve));
    const address = facade.address();
    assert.ok(address && typeof address === "object");
    const before = f.seen.length;
    for (const journal of pending) {
      const response = await fetch(
        "http://127.0.0.1:" + address.port + "/v2/operations/" + journal.operationId,
        {
          headers: {
            authorization: "Bearer " + grant.token,
            "content-type": "application/json",
            accept: "application/json",
            [lifecycleWire.LIFECYCLE_CAPABILITY_HEADER]:
              lifecycleWire.LIFECYCLE_CAPABILITY_CONTRACT,
            [lifecycleWire.LIFECYCLE_CLIENT_HEADER]: lifecycleWire.LIFECYCLE_CLIENT_CONTRACT,
          },
        },
      );
      assert.equal(response.status, 403);
      await response.arrayBuffer();
      assert.equal((await f.kernel.operation(f.context, journal.operationId)).state, "pending");
      assert.equal((await f.kernel.account(f.context, journal.accountRef)).state, "staging");
    }
    assert.equal(f.seen.length, before, "no protected OAuth readback/promotion attempted");
  } finally {
    facade.closeAllConnections();
    await new Promise<void>((resolve) => facade.close(() => resolve()));
    await f.close();
  }
});

// The journal model is the validated request model; response model authority is absent.
test("usage request selection preserves the second allowed model", async () => {
  const requested = validateResponses(
    Buffer.from(
      JSON.stringify({ model: "second", stream: true, store: false, service_tier: "default" }),
    ),
    ["first", "second"],
    100,
  );
  assert.equal(requested, "second");
});

// Red if family is caller-selected, a Claude device flow enters native HTTP,
// or a spent secret can be replayed after an ambiguous completion.
test("source HTTP: Claude browser completion follows saved profile and qualified physical birth", async () => {
  const f = await sourceHTTP("claude");
  try {
    f.connect("prepared");
    const sdk = createManagementClient({
      role: "management",
      origin: f.facadeOrigin,
      token: "source-public-management",
    });
    const profiles = await sdk.profiles();
    assert.deepEqual(
      profiles.profiles.find((p) => p.profileId === claudeOAuthProfile.profile),
      {
        profileId: claudeOAuthProfile.profile,
        protocol: "openai-responses",
        modelIds: ["claude-sonnet-4-6"],
        authKinds: ["oauth"],
      },
    );
    const operationId = randomUUID(),
      state = "a".repeat(64),
      code = "x".repeat(8192);
    const begin = {
      operationId,
      ownerRef: "owner-one",
      profileId: claudeOAuthProfile.profile,
      displayName: "Claude fixture",
    };
    const begun = await sdk.beginOAuth(begin);
    assert.equal(begun.operation.state, "pending");
    const journal = f.journals.get(f.scopeKey(f.context, operationId))!;
    const lookup = {
      consumerId: journal.consumerId,
      operationId,
      accountRef: journal.accountRef,
      generation: journal.generation,
    };
    assert.equal((await f.callback("oauth-owner-authority", lookup)).status, 200);
    f.connect("completed");
    assert.equal((await sdk.readOAuth(operationId)).state, "pending");
    assert.equal(
      f.seen.some((call) => call.path === "POST /private/native/v1/claude/oauth/refresh"),
      false,
      "display GET cannot refresh provider credentials",
    );
    f.connect("prepared");
    const before = f.seen.length;
    assert.equal(
      (
        await f.publicCall("/v1/accounts/oauth/begin", {
          ...begin,
          operationId: randomUUID(),
          method: "device_code",
        })
      ).status,
      403,
    );
    assert.equal(
      (await f.publicCall("/v1/accounts/oauth/poll", { operationId, ownerRef: "owner-one" }))
        .status,
      403,
    );
    const wrongFamily = {
      operationId,
      ownerRef: "owner-one",
      callbackURL: "http://localhost:1455/auth/callback?code=fixture&state=" + state,
    };
    assert.equal((await f.publicCall("/v1/accounts/oauth/complete", wrongFamily)).status, 400);
    assert.equal(
      f.seen.length,
      before,
      "wrong family and method reject before protected native request",
    );
    const input = { operationId, ownerRef: "owner-one", authorizationCode: code + "#" + state };
    assert.equal(
      (await f.publicCall("/v1/accounts/oauth/complete", { ...input, ownerRef: "owner-two" }))
        .status,
      403,
    );
    const d: PhysicalCandidate = {
      ...claudeOAuthProfile,
      generation: journal.generation,
      nativePhysicalIdentity: journal.generation,
      nativeId: 42,
      createdAt: "2026-10-06T01:02:03.123456789Z",
    };
    f.descriptor({
      operation: operationId,
      account_ref: journal.accountRef,
      state: "staged",
      qualification: "controlled-source-v1",
      native: {
        account_id: d.nativeId,
        generation: d.generation,
        created_at: d.createdAt,
        profile: d.profile,
        base_url: d.baseURL,
        model: d.model,
      },
    });
    const applied = await sdk.completeOAuth(input);
    assert.equal(applied.state, "applied");
    assert.equal(f.completions(), 1);
    assert.deepEqual(
      f.seen.find((s) => s.path === "POST /private/native/v1/claude/oauth/connect/complete")?.tuple,
      {
        operation: operationId,
        owner_ref: journal.ownerRef,
        account_ref: journal.accountRef,
        generation: journal.generation,
        state,
        code,
      },
    );
    assert.deepEqual(await sdk.completeOAuth(input), applied);
    assert.equal(f.completions(), 1);
    assert.equal((await sdk.get(journal.accountRef)).state, "active");
    assert.equal(JSON.stringify(applied).includes(code), false);
    f.control.bearers.replace([]);
    assert.equal((await f.callback("oauth-owner-authority", lookup)).status, 403);
  } finally {
    await f.close();
  }
});

test("production cached-read composition advertises native v2 through the real facade and native HTTP client", async () => {
  const f = await sourceHTTP(false);
  try {
    const response = await f.publicCall("/v2/capabilities/account-limits");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      contract: "account-limits/v2",
      cachedRead: true,
      quotaOnlyRefresh: false,
    });
    assert.equal(
      f.seen.filter((entry) => entry.path === "GET /private/native/v2/account-limits/capabilities")
        .length,
      1,
    );
    assert.equal(f.forwarded.length, 0);
    assert.equal(f.begins(), 0);
    assert.equal(f.completions(), 0);
  } finally {
    await f.close();
  }
});

for (const contract of ["v1", "v2"] as const)
  test(
    "protected concurrent " +
      contract +
      " limits reads reserve sockets for real native authority and control callbacks",
    { timeout: 10_000 },
    async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered = 0,
        seventhEntered!: () => void,
        sixEntered!: () => void;
      const six = new Promise<void>((resolve) => {
        sixEntered = resolve;
      });
      const seventh = new Promise<"entered">((resolve) => {
        seventhEntered = () => resolve("entered");
      });
      const f = await sourceHTTP(true, false, {
        contract,
        enter: async () => {
          entered++;
          if (entered === 6) sixEntered();
          if (entered === 7) seventhEntered();
          await gate;
        },
      });
      const reserve = protectedReadSockets();
      let authorityCalls = 0;
      const callbackHandler = f.authority.createServer();
      const listener = createServer((req, res) => {
        if (facadeControlRoute(req.method, req.url)) {
          if (reserve(req, res)) f.facade.emit("request", req, res);
          return;
        }
        authorityCalls++;
        callbackHandler.emit("request", req, res);
      });
      listener.maxConnections = 8;
      listener.maxRequestsPerSocket = 1;
      const pending: Promise<Response>[] = [];
      try {
        await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
        const address = listener.address();
        assert.ok(address && typeof address === "object");
        const origin = "http://127.0.0.1:" + address.port;
        f.callbackOriginTo(origin);
        const accountRef = randomUUID(),
          generation = randomUUID(),
          operationId = randomUUID();
        const profile = {
          ...(contract === "v1" ? codexOAuthProfile : kimiProfile),
          qualificationRef: "source-limits",
          limits: f.profile.limits,
          providerTokenUpperBound: 1000,
        };
        const account: AccountStatus = {
          accountRef,
          ownerRef: "owner-one",
          profile: profile.profile,
          displayName: "Cached read fixture",
          state: "active",
          revision: 1,
          epoch: 1,
        };
        f.accounts.set(f.scopeKey(f.context, accountRef), account);
        f.mappings.set(f.scopeKey(f.context, generation), {
          consumerId: f.context.consumerId,
          operationId,
          accountRef,
          ownerRef: account.ownerRef,
          purpose: "create",
          generation,
          worker: randomUUID(),
          profile,
          descriptor: {
            generation,
            nativePhysicalIdentity: generation,
            nativeId: 42,
            createdAt: "2026-10-06T01:02:03Z",
            ...profile,
          },
        });
        f.kernel.accountLimitsIdentity = async () => ({
          ...account,
          generation,
          nativePhysicalIdentity: generation,
        });
        const input = {
          accountRef,
          ownerRef: account.ownerRef,
          profileId: profile.profile,
          expectedAuthorizationEpoch: 1,
        };
        const read = () =>
          fetch(origin + "/" + contract + "/account-limits/read", {
            method: "POST",
            headers: {
              authorization: "Bearer source-public-management",
              "content-type": "application/json",
              accept: "application/json",
              connection: "close",
            },
            body: JSON.stringify(input),
          });
        for (let i = 0; i < 6; i++) pending.push(read());
        await Promise.race([
          six,
          Promise.all(pending).then((responses) => {
            throw new Error(
              "cached reads returned before native gate: " +
                responses.map((response) => response.status).join(","),
            );
          }),
        ]);
        const overflow = read();
        pending.push(overflow);
        const outcome = await Promise.race([overflow.then((response) => response.status), seventh]);
        assert.equal(outcome, 503, "seventh cached read must not occupy a native callback socket");
        // A separate protected control request still enters while six public reads
        // are waiting on native HTTP; their native owner callbacks then enter too.
        const capabilities = await fetch(origin + "/v2/capabilities/account-limits", {
          headers: {
            authorization: "Bearer source-public-management",
            "content-type": "application/json",
            accept: "application/json",
            connection: "close",
          },
        });
        assert.equal(capabilities.status, 200);
        await capabilities.arrayBuffer();
        release();
        const responses = await Promise.all(pending.slice(0, 6));
        for (const response of responses) {
          assert.equal(response.status, 200);
          assert.deepEqual(await response.json(), { status: "unknown" });
        }
        assert.equal(entered, 6);
        assert.equal(authorityCalls, 6);
        assert.equal(f.forwarded.length, 0);
        for (const path of [
          "/" + contract + "/account-limits/read?extra=1",
          "/" + contract + "/account-limits/read/extra",
          "/" + contract + "/account-limits/%72ead",
        ])
          assert.equal(facadeBoundedReadRoute("POST", path), false);
        assert.equal(facadeBoundedReadRoute("GET", "/" + contract + "/account-limits/read"), false);
        assert.equal(facadeBoundedReadRoute("GET", "/v2/capabilities/account-limits"), false);
      } finally {
        release();
        await Promise.allSettled(pending);
        listener.closeAllConnections();
        await new Promise<void>((resolve) => listener.close(() => resolve()));
        callbackHandler.closeAllConnections();
        await f.close();
      }
    },
  );

test("source HTTP: Grok displayed code uses saved profile and never projects original state", async () => {
  const f = await sourceHTTP("grok");
  try {
    f.connect("prepared");
    const sdk = createManagementClient({
      role: "management",
      origin: f.facadeOrigin,
      token: "source-public-management",
    });
    const capabilities = await sdk.getProviderConnectionCapabilities();
    assert.equal(
      capabilities.capabilities.find((p) => p.profileId === grokOAuthProfile.profile)
        ?.completionInputKind,
      "authorization_code",
    );
    const operationId = randomUUID();
    await sdk.beginOAuth({
      operationId,
      ownerRef: "owner-one",
      profileId: grokOAuthProfile.profile,
      displayName: "Grok fixture",
    });
    const j = f.journals.get(f.scopeKey(f.context, operationId))!;
    const before = f.seen.length;
    for (const authorizationCode of ["claude-code#" + "a".repeat(64), "bad?query"])
      assert.equal(
        (
          await f.publicCall("/v1/accounts/oauth/complete", {
            operationId,
            ownerRef: "owner-one",
            authorizationCode,
          })
        ).status,
        400,
      );
    assert.equal(
      (
        await f.publicCall("/v1/accounts/oauth/complete", {
          operationId,
          ownerRef: "owner-two",
          authorizationCode: "displayed-code",
        })
      ).status,
      403,
    );
    assert.equal(f.seen.length, before);
    f.descriptor({
      operation: operationId,
      account_ref: j.accountRef,
      state: "staged",
      qualification: "controlled-source-v1",
      native: {
        account_id: 42,
        generation: j.generation,
        created_at: "2026-10-06T01:02:03.123456789Z",
        profile: grokOAuthProfile.profile,
        base_url: grokOAuthProfile.baseURL,
        model: grokOAuthProfile.model,
      },
    });
    const input = { operationId, ownerRef: "owner-one", authorizationCode: "displayed-code" };
    const applied = await sdk.completeOAuth(input);
    assert.equal(applied.state, "applied");
    assert.equal(f.completions(), 1);
    assert.deepEqual(
      f.seen.find((s) => s.path === "POST /private/native/v1/grok/oauth/connect/complete")?.tuple,
      {
        operation: operationId,
        owner_ref: j.ownerRef,
        account_ref: j.accountRef,
        generation: j.generation,
        authorizationCode: "displayed-code",
      },
    );
    assert.deepEqual(await sdk.completeOAuth(input), applied);
    assert.equal(f.completions(), 1);
    assert.equal(JSON.stringify(applied).includes("displayed-code"), false);
  } finally {
    await f.close();
  }
});


function modelAccount(f: Awaited<ReturnType<typeof sourceHTTP>>, source: "codex" | "openrouter" = "codex") {
  const accountRef = randomUUID(), generation = randomUUID();
  const profile = source === "codex" ? { ...codexOAuthProfile, qualificationRef: "source-codex", limits: f.profile.limits,
    providerTokenUpperBound: 1000 } : f.cfg.secondProfile;
  const account: AccountStatus = { accountRef, ownerRef: "owner-one", profile: profile.profile,
    displayName: "Model catalogue fixture", state: "active", revision: 1, epoch: 1 };
  f.accounts.set(f.scopeKey(f.context, accountRef), account);
  f.mappings.set(f.scopeKey(f.context, generation), { consumerId: f.context.consumerId,
    operationId: randomUUID(), accountRef, ownerRef: account.ownerRef, purpose: "create",
    generation, worker: randomUUID(), profile,
    descriptor: { generation, nativePhysicalIdentity: generation, nativeId: 42,
      createdAt: "2026-10-06T01:02:03Z", ...profile } });
  const input = { ownerRef: account.ownerRef, accountRef, profileId: profile.profile, expectedAuthorizationEpoch: 1 };
  const snapshot: lifecycleWire.AccountModels = { status: "snapshot", physicalGeneration: generation,
    principalVersion: "principal-fixture", source: "codex", fetchedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(), models: [{ modelId: "gpt-unseen-future",
      reasoning: { allowed: ["high", "ultra"], default: "high" },
      fast: { allowed: ["balanced"], default: "balanced" }, tools: { allowed: ["function"], default: "function" } }] };
  const discovered: lifecycleWire.AccountModels = source === "codex" ? snapshot : { ...snapshot, source: "openrouter",
    models: snapshot.models.map((model) => ({ ...model, modelId: "future-vendor/review:model", reasoning: null, fast: null })) };
  return { account, profile, generation, input, snapshot: discovered };
}

// Detects a broken SDK route/schema, leaked static membership, or lost authority fences after native I/O.
for (const source of ["codex", "openrouter"] as const)
test(`${source} account model SDK read uses scoped native catalogue and fences owner, epoch, generation and bearer changes`, async () => {
  const f = await sourceHTTP(true);
  try {
    const { account, input, snapshot, generation } = modelAccount(f, source);
    const sdk = createManagementClient({ role: "management", origin: f.facadeOrigin, token: "source-public-management" });
    f.modelResult(snapshot);
    assert.deepEqual(await sdk.readAccountModels({ ...input, forceRefresh: true }), snapshot);
    assert.deepEqual(f.seen.find((r) => r.path === "POST /private/native/v1/account-models/read")?.tuple,
      { ...input, forceRefresh: true });
    for (const change of [{ ownerRef: "foreign" }, { expectedAuthorizationEpoch: 2 }, { profileId: "foreign" }]) {
      await assert.rejects(sdk.readAccountModels({ ...input, ...change }));
    }
    for (const mutation of [
      () => { account.epoch++; },
      () => { account.ownerRef = "foreign"; },
      () => { const current = f.mappings.get(f.scopeKey(f.context, generation))!;
        f.mappings.set(f.scopeKey(f.context, generation), { ...current,
          descriptor: { ...current.descriptor, nativeId: 99 } }); },
      () => { f.control.bearers.replace([]); },
    ]) {
      const old = { epoch: account.epoch, ownerRef: account.ownerRef };
      const mapping = f.mappings.get(f.scopeKey(f.context, generation))!;
      f.modelResult(snapshot, async () => mutation());
      await assert.rejects(sdk.readAccountModels(input));
      Object.assign(account, old);
      f.mappings.set(f.scopeKey(f.context, generation), mapping);
      f.control.bearers.replace(f.cfg.bearers);
    }
    f.modelResult({ ...snapshot, physicalGeneration: randomUUID() });
    await assert.rejects(sdk.readAccountModels(input));
    f.modelResult({ ...snapshot, source: source === "codex" ? "openrouter" : "codex", models: [] });
    await assert.rejects(sdk.readAccountModels(input));
    f.modelResult({ ...snapshot, models: [] });
    assert.deepEqual(await sdk.readAccountModels(input), { ...snapshot, models: [] });
    f.modelResult({ ...snapshot, fetchedAt: new Date(Date.now() - 5000).toISOString(), expiresAt: new Date(Date.now() - 1).toISOString() });
    assert.deepEqual(await sdk.readAccountModels(input), { status: "unknown" });
  } finally { await f.close(); }
});

// Dynamic membership must reach the existing transport without changing its persisted enrollment anchor.
test("dynamic Codex selection reaches native transport; unknown, unsupported effort and empty catalogues never enter", async () => {
  const f = await sourceHTTP(true);
  try {
    const { account, profile, generation, snapshot } = modelAccount(f);
    assert.ok(snapshot.source === "codex");
    const executionRef = randomUUID();
    const saved: SavedExecution = { generation, state: "open", dispatchAllowed: true,
      admission: { executionRef, issuerEpoch: await f.kernel.issuer(f.context), invocationRef: "models-test", attemptRef: "attempt",
        accountRef: account.accountRef, authorizationEpoch: 1, subjectRef: "subject", policyRevision: 1,
        bindingRevision: 1, profileId: profile.profile, limits: profile.limits,
        expiresAt: new Date(Date.now() + 20_000).toISOString() } };
    f.executions.set(f.scopeKey(f.context, executionRef), saved);
    f.control.bearers.replace([...f.cfg.bearers, { role: "execution", consumerId: f.context.consumerId,
      token: "source-model-execution", saved }]);
    const { executionRef: _, issuerEpoch: __, ...admission } = saved.admission;
    const submit = (patch: Record<string, unknown> = {}) => f.publicCall("/v1/executions/" + executionRef + "/requests",
      { model: "gpt-unseen-future", stream: true, store: false, reasoning: { effort: "ultra" },
        tools: [{ type: "function", name: "fixture", parameters: {} }], ...patch }, "source-model-execution",
      { "x-gateway-request-id": randomUUID(), "x-gateway-admission": JSON.stringify(admission) });
    f.modelResult(snapshot);
    for (const patch of [{ model: "unknown" }, { reasoning: { effort: "low" } },
      { service_tier: "priority" }]) {
      assert.equal((await submit(patch)).status, 400);
      assert.equal(f.forwarded.length, 0);
      assert.equal(f.seen.filter((entry) => entry.path === "POST /private/native/v1/transports").length, 0);
    }
    const accepted = await submit();
    assert.equal(accepted.status, 200);
    await accepted.text();
    assert.equal(f.forwarded.length, 1);
    assert.equal((f.forwarded[0].body as Record<string, unknown>).model, "gpt-unseen-future");
    assert.equal(f.mappings.get(f.scopeKey(f.context, generation))!.descriptor.model, profile.model);
    // Metadata advertises the upstream function protocol. Preserve qualified
    // custom input for the existing native custom-to-function codec.
    const customTools = [{ type: "custom", name: "apply_patch", description: "Apply a patch",
      format: { type: "grammar", syntax: "lark", definition: "start: /(.|\\n)*/" } }];
    const custom = await submit({ tools: customTools });
    assert.equal(custom.status, 200);
    await custom.text();
    assert.equal(f.forwarded.length, 2);
    assert.deepEqual((f.forwarded[1].body as Record<string, unknown>).tools, customTools);
    f.modelResult({ ...snapshot, models: snapshot.models.map((model) => ({ ...model, reasoning: null })) });
    for (const reasoning of [{ effort: "high" }, { summary: "none" }, { context: "all_turns" }, { unknown: null }, [], false]) {
      assert.equal((await submit({ reasoning })).status, 400);
      assert.equal(f.forwarded.length, 2);
    }
    // Both facade admission and saved-lease NativeAuthority.prepare see the same
    // disabled account policy before the untouched request reaches native HTTP.
    const disabled = await submit({ reasoning: {} });
    assert.equal(disabled.status, 200);
    await disabled.text();
    assert.equal(f.forwarded.length, 3);
    assert.deepEqual((f.forwarded[2].body as Record<string, unknown>).reasoning, {});
    f.modelResult({ ...snapshot, models: [] });
    assert.equal((await submit({ model: profile.model })).status, 400);
    for (const status of ["unknown", "unsupported"] as const) {
      f.modelResult({ status });
      assert.equal((await submit({ model: profile.model })).status, 400);
    }
    f.modelResult({ status: "unavailable" });
    assert.equal((await submit()).status, 400);
    const anchor = await submit({ model: profile.model, reasoning: undefined });
    assert.equal(anchor.status, 200);
    await anchor.text();
  } finally { await f.close(); }
});

// Both public and native saved-lease admission consume the same discovered set.
test("dynamic OpenRouter membership reaches transport without rewriting the immutable enrollment anchor", async () => {
  const f = await sourceHTTP(true);
  try {
    const { account, profile, generation, snapshot } = modelAccount(f, "openrouter");
    assert.ok(snapshot.source === "openrouter");
    const executionRef = randomUUID();
    const saved: SavedExecution = { generation, state: "open", dispatchAllowed: true,
      admission: { executionRef, issuerEpoch: await f.kernel.issuer(f.context), invocationRef: "openrouter-models", attemptRef: "attempt",
        accountRef: account.accountRef, authorizationEpoch: 1, subjectRef: "subject", policyRevision: 1,
        bindingRevision: 1, profileId: profile.profile, limits: profile.limits,
        expiresAt: new Date(Date.now() + 20_000).toISOString() } };
    f.executions.set(f.scopeKey(f.context, executionRef), saved);
    f.control.bearers.replace([...f.cfg.bearers, { role: "execution", consumerId: f.context.consumerId,
      token: "source-openrouter-model-execution", saved }]);
    const { executionRef: _, issuerEpoch: __, ...admission } = saved.admission;
    const submit = (model = "future-vendor/review:model", patch: Record<string, unknown> = {}) =>
      f.publicCall("/v1/executions/" + executionRef + "/requests", { model, stream: true, store: false,
        tools: [{ type: "function", name: "fixture", parameters: {} }], ...patch }, "source-openrouter-model-execution",
        { "x-gateway-request-id": randomUUID(), "x-gateway-admission": JSON.stringify(admission) });
    f.modelResult(snapshot);
    assert.equal((await submit("outside-the-live-set")).status, 400);
    assert.equal((await submit(undefined, { reasoning: { effort: "high" } })).status, 400);
    assert.equal(f.forwarded.length, 0);
    const accepted = await submit(); assert.equal(accepted.status, 200); await accepted.text();
    assert.equal((f.forwarded[0].body as Record<string, unknown>).model, "future-vendor/review:model");
    assert.equal(f.mappings.get(f.scopeKey(f.context, generation))!.descriptor.model, profile.model);
    assert.ok(f.seen.filter((r) => r.path === "POST /private/native/v1/account-models/read").length >= 2);
    f.modelResult({ ...snapshot, models: [] });
    assert.equal((await submit(profile.model)).status, 400);
    for (const status of ["unknown", "unsupported"] as const) {
      f.modelResult({ status }); assert.equal((await submit(profile.model)).status, 400);
    }
    // Failed observations never acquire the explicit unavailable fallback authority.
    for (const observed of [
      { ...snapshot, models: [{ modelId: "invalid model" }] },
      { ...snapshot, fetchedAt: new Date(Date.now() - 5000).toISOString(), expiresAt: new Date(Date.now() - 1).toISOString() },
      { ...snapshot, fetchedAt: new Date(Date.now() + 50_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() },
      undefined,
    ]) {
      f.modelResult(observed);
      assert.equal((await submit(profile.model)).status, 400);
    }
    f.modelResult({ status: "unavailable" }, undefined, 503);
    assert.equal((await submit(profile.model)).status, 400);
    f.modelResult({ status: "unavailable" });
    assert.equal((await submit()).status, 400);
    const anchor = await submit(profile.model); assert.equal(anchor.status, 200); await anchor.text();
  } finally { await f.close(); }
});

// Missing composition is not an observed outage and cannot grant fallback membership.
test("qualified OpenRouter execution with a missing discovery source denies its anchor before transport", async () => {
  const f = await sourceHTTP(true, false, undefined, true);
  try {
    const { account, profile, generation, input } = modelAccount(f, "openrouter");
    const sdk = createManagementClient({ role: "management", origin: f.facadeOrigin, token: "source-public-management" });
    assert.deepEqual(await sdk.readAccountModels(input), { status: "unknown" });
    const executionRef = randomUUID();
    const saved: SavedExecution = { generation, state: "open", dispatchAllowed: true,
      admission: { executionRef, issuerEpoch: await f.kernel.issuer(f.context), invocationRef: "missing-source", attemptRef: "attempt",
        accountRef: account.accountRef, authorizationEpoch: 1, subjectRef: "subject", policyRevision: 1, bindingRevision: 1,
        profileId: profile.profile, limits: profile.limits, expiresAt: new Date(Date.now() + 20_000).toISOString() } };
    f.executions.set(f.scopeKey(f.context, executionRef), saved);
    f.control.bearers.replace([...f.cfg.bearers, { role: "execution", consumerId: f.context.consumerId, token: "missing-model-source", saved }]);
    const { executionRef: _, issuerEpoch: __, ...admission } = saved.admission;
    const result = await f.publicCall("/v1/executions/" + executionRef + "/requests",
      { model: profile.model, stream: true, store: false }, "missing-model-source",
      { "x-gateway-request-id": randomUUID(), "x-gateway-admission": JSON.stringify(admission) });
    assert.equal(result.status, 400);
    assert.equal(f.forwarded.length, 0);
    assert.equal(f.seen.some((row) => row.path === "POST /private/native/v1/transports"), false);
  } finally { await f.close(); }
});
