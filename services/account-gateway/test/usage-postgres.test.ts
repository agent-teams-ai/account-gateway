import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { PostgresUsageJournal } from "../src/usage.ts";
import type { UsageObservation } from "@agent-teams/account-gateway/contracts";

test("real PostgreSQL journal deduplicates concurrent writes and freezes bounded pages across late corrections", async () => {
  const database = process.env.AG_USAGE_DISPOSABLE_DB;
  if (!database || !/^ag_usage_test_[a-z0-9_]+$/.test(database))
    throw new Error("NOT_RUN: explicit new disposable local DB required");
  const dsn = process.env.AG_USAGE_TEST_DSN;
  if (dsn) {
    const url = new URL(dsn);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.pathname !== "/" + database ||
      url.search ||
      url.hash
    )
      throw new Error("refusing remote or unspecified journal fixture DB");
  }
  const pool = new pg.Pool(
    dsn ? { connectionString: dsn, max: 4 } : { host: "/tmp", database, max: 4 },
  );
  try {
    assert.equal(
      (await pool.query("SELECT 1 FROM pg_namespace WHERE nspname='ag_kernel'")).rowCount,
      0,
    );
    // Journal-specific SQL contract fixture; complete kernel migrations are a separate gate.
    await pool.query(
      "CREATE SCHEMA ag_kernel; CREATE TABLE ag_kernel.consumers(consumer text PRIMARY KEY); CREATE TABLE ag_kernel.requests(consumer text,execution_ref uuid,id text,PRIMARY KEY(consumer,execution_ref,id));",
    );
    await pool.query(
      await readFile(new URL("../migrations/008_usage_journal.sql", import.meta.url), "utf8"),
    );
    await pool.query(
      "INSERT INTO ag_kernel.consumers VALUES('one'),('two'); INSERT INTO ag_kernel.requests VALUES('one','00000000-0000-4000-8000-000000000001','request'),('two','00000000-0000-4000-8000-000000000001','request')",
    );
    const journal = new PostgresUsageJournal(pool, Buffer.alloc(32, 7));
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
    await Promise.all([
      journal.append({ consumerId: "one" }, fact),
      journal.append({ consumerId: "one" }, fact),
    ]);
    assert.equal(
      (await pool.query("SELECT COUNT(*)::int AS n FROM ag_kernel.usage_observations")).rows[0].n,
      1,
    );
    const first = await journal.list({ consumerId: "one" }, { limit: 1 });
    assert.equal(first.observations.length, 1);
    await journal.append(
      { consumerId: "one" },
      { ...fact, revision: 1, effect: "completed", inputTokens: 13, outputTokens: 7 },
    );
    const bounded = await journal.list(
      { consumerId: "one" },
      { afterCursor: first.nextCursor, highWaterCursor: first.highWaterCursor, limit: 1 },
    );
    assert.equal(bounded.observations.length, 0);
    const next = await journal.list(
      { consumerId: "one" },
      { afterCursor: bounded.nextCursor, limit: 1 },
    );
    assert.equal(next.observations[0]?.revision, 1);
    assert.equal(
      (await journal.observe({ consumerId: "one" }, fact.executionRef, fact.requestRef))?.revision,
      1,
    );
    assert.equal(
      await journal.observe({ consumerId: "two" }, fact.executionRef, fact.requestRef),
      null,
    );
    await assert.rejects(journal.append({ consumerId: "one" }, { ...fact, inputTokens: 99 }), {
      message: "conflict",
    });
    await assert.rejects(journal.list({ consumerId: "two" }, { afterCursor: first.nextCursor }), {
      message: "denied",
    });
    assert.equal(
      (await journal.list({ consumerId: "two" }, { limit: 100 })).observations.length,
      0,
    );
    for (let i = 0; i < 80; i++) {
      const id = "r" + String(i).padStart(3, "0") + "x".repeat(124);
      await pool.query("INSERT INTO ag_kernel.requests VALUES($1,$2,$3)", [
        "one",
        fact.executionRef,
        id,
      ]);
      await journal.append(
        { consumerId: "one" },
        {
          ...fact,
          requestRef: id,
          eventId: id,
          invocationRef: "i".repeat(128),
          attemptRef: "a".repeat(128),
          accountRef: "b".repeat(128),
          profileId: "p".repeat(128),
          model: "m".repeat(128),
        },
      );
    }
    const large = await journal.list({ consumerId: "one" }, { limit: 100 });
    assert.ok(Buffer.byteLength(JSON.stringify(large)) < 65_536);
    assert.ok(large.observations.length < 82 && large.observations.length > 0);
    const rest = await journal.list(
      { consumerId: "one" },
      { afterCursor: large.nextCursor, highWaterCursor: large.highWaterCursor, limit: 100 },
    );
    assert.equal(large.observations.length + rest.observations.length, 82);
    assert.equal(
      new Set(
        [...large.observations, ...rest.observations].map((f) => f.eventId + ":" + f.revision),
      ).size,
      82,
    );
  } finally {
    await pool.end();
  }
});
