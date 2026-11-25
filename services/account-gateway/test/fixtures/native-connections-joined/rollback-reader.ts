/** A fresh Node process loads only the verified old production bundle and a
 * copied SQL dependency closure. It never composes discovery or provider ports. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import type { PostgresKernel } from "../../../src/postgres.ts";
import type { PostgresManagementStore, IntentSecrets } from "../../../src/management-store.ts";
import type { GatewayRollbackInput } from "./rollback.ts";

const digest = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return "[" + value.map(canonical).join(",") + "]";
  }
  if (value !== null && typeof value === "object") {
    return (
      "{" +
      Object.entries(value)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => JSON.stringify(key) + ":" + canonical(item))
        .join(",") +
      "}"
    );
  }
  const encoded = JSON.stringify(value);
  assert.equal(typeof encoded, "string");
  return encoded;
}
const specPath = process.argv[2];
assert.ok(isAbsolute(specPath));
const bytes = await readFile(specPath);
assert.ok(bytes.length < 1_048_576);
const input = JSON.parse(bytes.toString("utf8")) as GatewayRollbackInput;
assert.equal(input.contract, "gateway-native-connection-old-reader/v1");
assert.equal(input.readerSHA, "bcfcde2d06d7bbdb941258e1908986b9f5718feb");
assert.equal(digest(await readFile(input.bundle)), input.bundleSHA256);
for (const dependency of input.dependencies) {
  const files: Record<string, string> = {};
  async function visit(directory: string) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.name === "node_modules") {
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else {
        assert.ok(entry.isFile());
        files[relative(dependency.root, path)] = digest(await readFile(path));
      }
    }
  }
  await visit(dependency.root);
  assert.deepEqual(files, dependency.files);
  for (const [name, target] of Object.entries(dependency.links)) {
    assert.equal(await realpath(join(dependency.root, "node_modules", name)), target);
    assert.ok(
      input.dependencies.some((candidate) => candidate.name === name && candidate.root === target),
    );
  }
}
const target = new URL(input.databaseURL);
assert.equal(target.protocol, "postgresql:");
assert.equal(target.hostname, "127.0.0.1");
assert.equal(target.username, "postgres");
assert.equal(target.password, "");
assert.equal(target.search, "?sslmode=disable");
assert.ok(target.pathname.startsWith("/ag_kernel_test_connections_joined_"));
const require = createRequire(import.meta.url);
const sql = require(input.pgEntry) as { Pool: typeof Pool };
const old = (await import(pathToFileURL(input.bundle).href)) as {
  PostgresKernel: typeof PostgresKernel;
  PostgresManagementStore: typeof PostgresManagementStore;
  IntentSecrets: typeof IntentSecrets;
};
const pool = new sql.Pool({
  connectionString: input.databaseURL,
  max: 2,
  connectionTimeoutMillis: 5000,
  query_timeout: 5000,
});
pool.on("error", () => {});
try {
  assert.equal(
    (
      await pool.query<{ version: string }>(
        "SELECT current_setting('server_version_num') AS version",
      )
    ).rows[0].version,
    "170010",
  );
  const kernel = new old.PostgresKernel(pool);
  const store = new old.PostgresManagementStore(
    pool,
    new old.IntentSecrets(randomBytes(32), randomBytes(32)),
  );
  const context = { consumerId: input.consumerId };
  const operation = await kernel.operation(context, input.operationId);
  const journal = await store.readJournal(context, input.operationId);
  assert.ok(journal?.connectionSnapshot && operation.connection);
  const mapping = await store.mapping(context, journal.generation);
  assert.equal(operation.state, input.expected.gatewayState);
  assert.equal(digest(canonical(operation)), input.expected.operationSHA256);
  assert.equal(digest(canonical(journal)), input.expected.journalSHA256);
  assert.equal(digest(canonical(mapping ?? null)), input.expected.mappingSHA256);
  assert.equal(digest(canonical(operation.connection)), input.expected.bindingSHA256);
  assert.deepEqual(journal.connectionSnapshot.connection, operation.connection.connection);
  assert.equal(mapping !== undefined, input.expected.gatewayState === "applied");
  // readJournal uses the production consumer SELECT FOR UPDATE lock. The
  // transaction is therefore not declared SQL READ ONLY; unchanged raw rows
  // prove read-only behaviour without replacing that production method.
  for (const expected of input.expected.tables) {
    assert.ok(
      [
        "ag_kernel.operations",
        "ag_kernel.candidates",
        "ag_management.candidate_journal",
        "ag_management.physical_mappings",
      ].includes(expected.table),
    );
    const rows = (
      await pool.query<{ body: string }>(
        `SELECT to_jsonb(source_row)::text AS body FROM ${expected.table} source_row WHERE consumer=$1 ORDER BY 1 LIMIT 4097`,
        [input.consumerId],
      )
    ).rows;
    assert.equal(rows.length, expected.rows);
    assert.equal(digest(canonical(rows.map((row) => row.body))), expected.sha256);
  }
  await writeFile(
    input.output,
    JSON.stringify({
      readerSHA: input.readerSHA,
      bundleSHA256: input.bundleSHA256,
      result: input.expected,
    }) + "\n",
    { mode: 0o600, flag: "wx" },
  );
} finally {
  await pool.end();
}
