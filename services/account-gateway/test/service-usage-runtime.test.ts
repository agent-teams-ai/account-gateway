// Explicit disposable root/Linux qualification of the real production listener.
// The operator supplies only a pinned native executable and two NEW local DBs.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTLSServer } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import { Pool, type PoolClient } from "pg";
import { createManagementClient, createExecutionClient } from "@agent-teams/account-gateway/http";
import { startService } from "../src/service.ts";
import type { Service } from "../src/service.ts";
import type {
  Prepare,
  Admission,
  UsagePage,
  UsageObservation,
} from "@agent-teams/account-gateway/contracts";

const installation = "/opt/account-gateway-service-usage";
const token = () => randomBytes(32).toString("base64url");
async function freeOrigin(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return "http://127.0.0.1:" + address.port;
}
function database(name: string, prefix: string): string {
  const input = process.env[name];
  if (input === undefined || input === "") {
    throw new Error("NOT_RUN: explicit disposable DB required");
  }
  const url = new URL(input);
  assert.ok(
    url.protocol === "postgres:" &&
      url.host === "127.0.0.1:5432" &&
      url.username === "postgres" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.pathname === "/" + prefix + "_20261022",
    "only owned loopback DB",
  );
  return input;
}
async function bounded<T>(work: Promise<T>, ms = 1500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("control capacity deadline"));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

void test(
  "production protected usage listener preserves role proofs, physical sockets and real SQL control capacity",
  { timeout: 45_000 },
  async () => {
    if (
      process.env.AG_SERVICE_USAGE_ALLOW !== "new_disposable_root_pg17_10" ||
      process.platform !== "linux" ||
      process.geteuid?.() !== 0
    ) {
      throw new Error("NOT_RUN: explicit isolated root/Linux fixture required");
    }
    const kernelDSN = database("AG_SERVICE_USAGE_KERNEL_DSN", "ag_usage_service"),
      nativeDSN = database("AG_SERVICE_USAGE_NATIVE_DSN", "native_bootstrap_usage");
    const expected = process.env.AG_SERVICE_USAGE_NATIVE_SHA256;
    const executable = installation + "/account-gateway";
    assert.match(expected ?? "", /^[a-f0-9]{64}$/);
    assert.equal(
      createHash("sha256")
        .update(await readFile(executable))
        .digest("hex"),
      expected,
    );
    const admin = new Pool({ connectionString: kernelDSN, max: 2, statement_timeout: 8000 });
    admin.on("error", () => {});
    const root = "/root/account_gateway_usage_" + randomUUID().replaceAll("-", "");
    await mkdir(root, { mode: 0o700 });
    await mkdir(root + "/authority", { mode: 0o700 });
    const consumerId = "usage-service-fixture",
      ownerRef = "usage-fixture-owner",
      model = "mimo-test",
      profileId = "openai-responses-apikey-v1";
    const limits = {
      requests: 2,
      concurrency: 1,
      requestBytes: 4096,
      outputBytes: 65536,
      tokens: 32,
    };
    const controlToken = token(),
      runToken = token(),
      managementToken = token(),
      dummyKey = token();
    const consumer = {
      consumerId,
      managementCredential: token(),
      executionCredential: token(),
      cleanupCredential: token(),
      callbackCredential: token(),
    };
    let upstreamCalls = 0;
    const upstream = createTLSServer(
      {
        cert: await readFile(installation + "/server.pem"),
        key: await readFile(installation + "/server-key.pem"),
      },
      (req, res) => {
        void (async () => {
          assert.equal(req.method, "POST");
          assert.equal(req.url, "/v1/responses");
          assert.equal(req.headers.authorization, "Bearer " + dummyKey);
          let bytes = 0;
          for await (const chunk of req) {
            const value: unknown = chunk;
            assert.ok(typeof value === "string" || value instanceof Uint8Array);
            bytes += Buffer.byteLength(value);
            assert.ok(bytes <= 4096);
          }
          upstreamCalls++;
          res.writeHead(200, { "content-type": "text/event-stream" });
          const part = {
            type: "output_text",
            text: "controlled result",
            annotations: [],
            logprobs: [],
          };
          const item = {
            type: "message",
            id: "fixture-message",
            role: "assistant",
            status: "completed",
            content: [part],
          };
          const response = {
            id: "fixture-response",
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
          res.write(frame("response.in_progress", { response: pending }));
          res.write(
            frame("response.output_item.added", {
              output_index: 0,
              item: { ...item, status: "in_progress", content: [] },
            }),
          );
          res.write(
            frame("response.content_part.added", {
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              part: { ...part, text: "" },
            }),
          );
          res.write(
            frame("response.output_text.delta", {
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              delta: part.text,
              logprobs: [],
            }),
          );
          res.write(
            frame("response.output_text.done", {
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              text: part.text,
              logprobs: [],
            }),
          );
          res.write(
            frame("response.content_part.done", {
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              part,
            }),
          );
          res.write(frame("response.output_item.done", { output_index: 0, item }));
          res.end(frame("response.completed", { response }));
        })().catch(() => {
          res.destroy();
        });
      },
    );
    let service: Service | undefined, blocker: PoolClient | undefined;
    const requests: Promise<Response>[] = [];
    try {
      const state = (
        await admin.query<{ version: string; empty: boolean }>(
          "SELECT current_setting('server_version') AS version, NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname IN ('ag_kernel','ag_management')) AS empty",
        )
      ).rows[0];
      assert.match(state.version, /^17\.10(?:$| )/);
      assert.equal(state.empty, true);
      const directory = new URL("../migrations/", import.meta.url);
      for (const file of (await readdir(directory))
        .filter((f) => /^\d{3}_.*\.sql$/.test(f))
        .toSorted()) {
        await admin.query(await readFile(new URL(file, directory), "utf8"));
      }
      await new Promise<void>((resolve) => {
        upstream.listen(0, "127.0.0.1", resolve);
      });
      const address = upstream.address();
      assert.ok(address !== null && typeof address === "object");
      const baseURL = "https://127.0.0.1:" + address.port + "/v1";
      const facadeOrigin = await freeOrigin(),
        callbackOrigin = await freeOrigin(),
        nativeOrigin = await freeOrigin();
      const profile = {
        profile: profileId,
        model,
        baseURL,
        qualificationRef: "controlled-usage-service-v1",
        limits,
        providerTokenUpperBound: 100,
      };
      const config = {
        kernelDSN,
        durableFacts: {
          maxServiceFacts: 512,
          maxConsumerFacts: 256,
          maxAccountFacts: 128,
          workerSlots: 2,
          issuerSlots: 3,
        },
        facadeOrigin,
        callbackOrigin,
        native: {
          executable,
          sha256: expected,
          bootstrapFile: root + "/bootstrap.json",
          authorityDir: root + "/authority",
          origin: nativeOrigin,
          originRef: "usage-service-origin",
          uid: 65534,
          gid: 65534,
        },
        consumer,
        profile,
        bearers: [
          {
            role: "consumer-control",
            token: controlToken,
            consumerId,
            profileIds: [profileId],
            limits,
            maxRunMs: 60_000,
          },
          {
            role: "run-control",
            token: runToken,
            consumerId,
            ownerRefs: [ownerRef],
            profileIds: [profileId],
            limits,
            maxRunMs: 60_000,
          },
          {
            role: "management",
            token: managementToken,
            consumerId,
            ownerRefs: [ownerRef],
            preparation: {
              accountRefs: [],
              subjectRef: "fixture-subject",
              policyRevision: 1,
              bindingRevision: 1,
              profileId,
              limits,
              maxRunMs: 60_000,
            },
          },
        ],
        keys: {
          intentAEAD: randomBytes(32).toString("base64"),
          intentHMAC: randomBytes(32).toString("base64"),
          facadeHMAC: randomBytes(32).toString("base64"),
        },
      };
      const bootstrap = {
        listenAddress: new URL(nativeOrigin).host,
        postgresDSN: nativeDSN + "?sslmode=disable",
        authority: { origin: callbackOrigin, credential: consumer.callbackCredential },
        custody: {
          activeKeyId: "fixture",
          keys: [{ id: "fixture", key: randomBytes(32).toString("base64") }],
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
          providerTokenUpperBound: 100,
        },
        maxEntries: 8,
      };
      await writeFile(root + "/bootstrap.json", JSON.stringify(bootstrap), {
        mode: 0o600,
        flag: "wx",
      });
      await writeFile(root + "/service.json", JSON.stringify(config), { mode: 0o600, flag: "wx" });
      service = await startService(root + "/service.json");
      const binding = service.binding;
      const management = createManagementClient({
        role: "management",
        origin: facadeOrigin,
        token: managementToken,
      });
      const created = await management.connect({
        operationId: randomUUID(),
        ownerRef,
        profileId,
        displayName: "Synthetic usage fixture",
        credential: { kind: "api_key", value: dummyKey },
      });
      const observedAccount: boolean =
        created.state === "applied" && created.result?.kind === "account";
      assert.ok(observedAccount);
      if (created.state !== "applied" || created.result?.kind !== "account") {
        throw new Error("fixture account not created");
      }
      const accountRef = created.result.accountRef;
      const get = (path: string, credential = controlToken) =>
        fetch(callbackOrigin + path, {
          headers: {
            authorization: "Bearer " + credential,
            accept: "application/json",
            "content-type": "application/json",
            connection: "close",
          },
          signal: AbortSignal.timeout(8000),
        });
      for (const [path, credential, status] of [
        ["/v1/usage?limit=1", controlToken, 200],
        ["/v1/usage", runToken, 403],
        ["/v1/usage", managementToken, 403],
        ["/v1/usage", "fixture-invalid-token", 401],
        ["/v1/usage?consumerId=x", controlToken, 403],
        ["/v1/usage/" + randomUUID() + "/request", controlToken, 200],
        ["/v1/usage/not-uuid/request", controlToken, 400],
      ] as const) {
        const response = await get(path, credential);
        assert.equal(response.status, status, path);
        await response.body?.cancel();
      }
      blocker = await admin.connect();
      await blocker.query("BEGIN");
      await blocker.query("LOCK ag_kernel.usage_observations IN ACCESS EXCLUSIVE MODE");
      for (let i = 0; i < 6; i++) {
        requests.push(get("/v1/usage?limit=1"));
      }
      let count = 0;
      for (let i = 0; i < 75; i++) {
        count = Number(
          (
            await admin.query<{ n: string }>(
              "SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT position,fact%'",
            )
          ).rows[0].n,
        );
        if (count === 6) {
          break;
        }
        await delay(20);
      }
      assert.equal(count, 6, "six real usage sockets and SQL clients must remain held");
      const excess = await bounded(get("/v1/usage?limit=1"));
      assert.equal(excess.status, 503);
      await excess.body?.cancel();
      const control = await bounded(get("/v1/accounts/" + accountRef));
      assert.equal(control.status, 200);
      await control.body?.cancel();
      assert.equal(upstreamCalls, 0, "capacity test must not dispatch provider work");
      await blocker.query("ROLLBACK");
      blocker.release();
      blocker = undefined;
      for (const response of await Promise.all(requests)) {
        assert.equal(response.status, 200);
        await response.body?.cancel();
      }
      const prepare: Prepare = {
        operationId: randomUUID(),
        invocationRef: randomUUID(),
        attemptRef: "usage-fixture-attempt",
        accountRefs: [accountRef],
        subjectRef: "fixture-subject",
        policyRevision: 1,
        bindingRevision: 1,
        profileId,
        limits,
        deadline: new Date(Date.now() + 30_000).toISOString(),
      };
      const accessResponse = await fetch(facadeOrigin + "/internal/v1/run-access", {
        method: "POST",
        headers: {
          authorization: "Bearer " + controlToken,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(prepare),
      });
      assert.equal(accessResponse.status, 200);
      const access = (await accessResponse.json()) as {
        bearer: string;
        admission: Admission;
        operation: { result: { executionRef: string } };
      };
      const executionRef = access.operation.result.executionRef;
      const execution = createExecutionClient({
        role: "execution",
        origin: facadeOrigin,
        token: access.bearer,
      });
      for (let i = 0; i < 2; i++) {
        const requestId = randomUUID(),
          result = await execution.request(executionRef, {
            requestId,
            admission: access.admission,
            body: Buffer.from(
              JSON.stringify({
                model,
                stream: true,
                store: false,
                service_tier: "default",
                input: [{ role: "user", content: "controlled fixture" }],
              }),
            ),
          });
        const observedKind: string = result.kind;
        assert.equal(observedKind, "stream");
        if (result.kind !== "stream") {
          throw new Error("no controlled stream");
        }
        for await (const chunk of result.body) {
          void chunk;
          /* bounded SDK stream consumed */
        }
        assert.equal((await execution.status(executionRef, requestId)).effect, "completed");
        let closed = false;
        for (let n = 0; n < 80; n++) {
          const row = (
            await admin.query<{
              transport_occupied: boolean;
              native_origin_ref: string | null;
              engine_incarnation: string | null;
            }>(
              "SELECT transport_occupied,native_origin_ref,engine_incarnation FROM ag_kernel.requests WHERE consumer=$1 AND execution_ref=$2 AND id=$3",
              [consumerId, executionRef, requestId],
            )
          ).rows.at(0);
          closed =
            row?.transport_occupied === false &&
            row.native_origin_ref === binding.originRef &&
            row.engine_incarnation === binding.incarnation;
          if (closed) {
            break;
          }
          await delay(20);
        }
        assert.equal(
          closed,
          true,
          "original authenticated physical closure must release SAME OPEN concurrency1",
        );
        const read = await get("/v1/usage/" + executionRef + "/" + requestId);
        assert.equal(read.status, 200);
        const { observation } = (await read.json()) as { observation: UsageObservation };
        assert.equal(observation.executionRef, executionRef);
        assert.equal(observation.requestRef, requestId);
        assert.equal(observation.revision, 2);
        assert.equal(observation.completeness, "complete");
        assert.equal(observation.effect, "completed");
        assert.equal(observation.inputTokens, 3);
        assert.equal(observation.outputTokens, 2);
        assert.equal(observation.cachedInputTokens, 0);
        assert.equal(observation.reasoningTokens, 0);
        assert.equal(observation.cost, null);
      }
      const listed = await get("/v1/usage?limit=1");
      assert.equal(listed.status, 200);
      const page = (await listed.json()) as UsagePage;
      const continued = await get(
        "/v1/usage?afterCursor=" +
          page.nextCursor +
          "&highWaterCursor=" +
          page.highWaterCursor +
          "&limit=100",
      );
      assert.equal(continued.status, 200);
      await continued.body?.cancel();
      assert.equal(upstreamCalls, 2);
      assert.equal(await service.stop(), "retired");
      service = undefined;
      await writeFile(
        installation + "/receipt.json",
        JSON.stringify({
          kind: "stats_compat_actual_service_qualification",
          nativeSha256: expected,
          blockedUsageSockets: 6,
          protectedControlRead: 200,
          excessUsage: 503,
          controlledLocalUpstreamRequests: 2,
          providerCalls: 0,
          sameOpenConcurrency1: true,
          originalPhysicalClosure: true,
          exactNativeRetirement: true,
        }) + "\n",
      );
    } finally {
      if (blocker) {
        await blocker.query("ROLLBACK").catch(() => {});
        blocker.release();
      }
      await Promise.allSettled(requests);
      if (service) {
        await service.stop();
      }
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => {
        upstream.close(() => {
          resolve();
        });
      });
      await admin.end();
    }
  },
);
