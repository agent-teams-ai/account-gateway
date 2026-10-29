import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Pool, PoolClient } from "pg";
import type { UsageObservation } from "@agent-teams/account-gateway/contracts";
import { PostgresUsageJournal } from "../src/usage.ts";

const fact: UsageObservation = {
  schemaVersion: 1,
  eventId: "event",
  revision: 0,
  executionRef: "00000000-0000-4000-8000-000000000001",
  requestRef: "request",
  invocationRef: "invocation",
  attemptRef: "attempt",
  accountRef: "account",
  profileId: "profile",
  model: "model",
  occurredAt: "2026-10-21T00:00:00Z",
  effect: "dispatch_started",
  completeness: "partial",
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
  reasoningTokens: null,
  cost: null,
};
function fixture(failAt: string, rollbackFails = false) {
  const original = new Error("original query failure"),
    queries: string[] = [],
    releases: unknown[] = [];
  const client = Object.assign(new EventEmitter(), {
    async query(sql: string) {
      queries.push(sql);
      if (sql === failAt) {
        throw original;
      }
      if (sql === "ROLLBACK" && rollbackFails) {
        throw new Error("rollback failure");
      }
      return { rows: [] };
    },
    release(error?: unknown) {
      releases.push(error);
    },
  });
  let connects = 0;
  const pool = {
    async connect() {
      connects++;
      return client as unknown as PoolClient;
    },
  } as unknown as Pool;
  return {
    journal: new PostgresUsageJournal(pool, Buffer.alloc(32, 7)),
    original,
    queries,
    releases,
    client,
    connects: () => connects,
  };
}

void test("append destroys the single checkout when BEGIN fails and preserves the original failure", async () => {
  const f = fixture("BEGIN");
  await assert.rejects(
    f.journal.append({ consumerId: "consumer" }, fact),
    (error) => error === f.original,
  );
  assert.deepEqual(f.queries, ["BEGIN"]);
  assert.deepEqual(f.releases, [true]);
  assert.equal(f.connects(), 1);
  assert.equal(f.client.listenerCount("error"), 0);
});

void test("append rollback failure never masks the query failure or leaks a reserved checkout", async () => {
  const f = fixture(
    "SELECT value FROM ag_kernel.usage_feed_counter WHERE singleton FOR UPDATE",
    true,
  );
  await assert.rejects(
    f.journal.append({ consumerId: "consumer" }, fact),
    (error) => error === f.original,
  );
  assert.equal(f.queries.at(-1), "ROLLBACK");
  assert.deepEqual(f.releases, [true]);
  assert.equal(f.connects(), 1);
  assert.equal(f.client.listenerCount("error"), 0);
});

void test("read/list query errors and malformed cursors release or avoid the one shared checkout", async () => {
  for (const operation of ["observe", "list"] as const) {
    const sql =
      operation === "observe"
        ? "SELECT fact FROM ag_kernel.usage_observations WHERE consumer=$1 AND execution_ref=$2 AND request_ref=$3 ORDER BY revision DESC LIMIT 1"
        : "SELECT value FROM ag_kernel.usage_feed_counter WHERE singleton";
    const f = fixture(sql);
    await assert.rejects(
      operation === "observe"
        ? f.journal.observe({ consumerId: "consumer" }, fact.executionRef, fact.requestRef)
        : f.journal.list({ consumerId: "consumer" }, {}),
      (error) => error === f.original,
    );
    assert.deepEqual(f.releases, [false]);
    assert.equal(f.connects(), 1);
    assert.equal(f.client.listenerCount("error"), 0);
    await assert.rejects(
      f.journal.list({ consumerId: "consumer" }, { afterCursor: "invalid.cursor" }),
      { message: "invalid" },
    );
    assert.equal(f.connects(), 1);
  }
});
