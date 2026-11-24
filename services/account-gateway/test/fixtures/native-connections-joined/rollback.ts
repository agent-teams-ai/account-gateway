/** Current joined writer -> exact compatible-floor production readers.
 * Only the frozen old source graph is bundled. Runtime SQL dependencies are
 * copied from the frozen runtime lock closure into an isolated, byte-checked closure. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import type { PostgresKernel } from "../../../src/postgres.ts";
import type { PostgresManagementStore } from "../../../src/management-store.ts";

export const gatewayCompatibleFloor = "bcfcde2d06d7bbdb941258e1908986b9f5718feb";
const esbuildSHA256 = "0c6588b092a2c291a72bab90659f3c9e0e25e0fe59c9ac12b4dae4d945e5548c";
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
export type GatewayRollbackCase = {
  gatewayState: "pending" | "applied" | "unknown";
  nativeStateEvidence: "prepared" | "completed" | "unknown_after_entered_exchange";
  operationSHA256: string;
  journalSHA256: string;
  mappingSHA256: string;
  bindingSHA256: string;
  tables: { table: string; rows: number; sha256: string }[];
  oldReaderPreserved: true;
  durableTablesUnchanged: true;
};
type Dependency = {
  name: string;
  version: string;
  root: string;
  files: Record<string, string>;
  links: Record<string, string>;
};
export type GatewayRollbackInput = {
  contract: "gateway-native-connection-old-reader/v1";
  readerSHA: string;
  bundle: string;
  bundleSHA256: string;
  pgEntry: string;
  dependencies: Dependency[];
  databaseURL: string;
  consumerId: string;
  operationId: string;
  expected: GatewayRollbackCase;
  output: string;
};
const versions: Readonly<Record<string, string>> = {
  pg: "8.23.1",
  "pg-connection-string": "2.14.1",
  "pg-pool": "3.14.0",
  "pg-protocol": "1.16.1",
  "pg-types": "2.2.0",
  pgpass: "1.0.5",
  "pg-cloudflare": "1.4.1",
  "pg-int8": "1.0.1",
  "postgres-array": "2.0.0",
  "postgres-bytea": "1.0.1",
  "postgres-date": "1.0.7",
  "postgres-interval": "1.2.0",
  split2: "4.2.0",
  xtend: "4.0.2",
};
/** Compare the entire frozen runtime closure (package integrity and snapshot
 * edges), not unrelated tooling in the writer workspace lock. */
function runtimeLockClosure(lock: string): string[][] {
  const names = [...Object.keys(versions), "zod"];
  const parts = lock.split("\npackages:\n");
  assert.equal(parts.length, 2);
  const sections = parts[1]!.split("\nsnapshots:\n");
  assert.equal(sections.length, 2);
  return sections.map((section) => {
    const entries = section.split(/(?=^  \S)/m);
    return names.toSorted().map((name) => {
      const matches = entries.filter((entry) => entry.startsWith("  " + name + "@"));
      assert.equal(matches.length, 1, "unique frozen lock entry for " + name);
      return matches[0]!.trimEnd();
    });
  });
}
async function fileTree(root: string): Promise<Record<string, string>> {
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
        assert.ok(entry.isFile(), "dependency package files must be regular files");
        files[relative(root, path)] = digest(await readFile(path));
      }
    }
  }
  await visit(root);
  return files;
}
async function isolatedPostgresDependencies(work: string, lock: string) {
  const requirements = new Map<
    string,
    {
      original: string;
      copy: string;
      metadata: {
        name: string;
        version: string;
        dependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      files: Record<string, string>;
    }
  >();
  const initial = createRequire(import.meta.url);
  async function collect(name: string, from: string) {
    if (requirements.has(name)) {
      return;
    }
    assert.ok(Object.hasOwn(versions, name), "the old SQL reader has a closed dependency graph");
    const require = createRequire(from);
    // A package can keep package.json private in its export map. Resolve its
    // public entry first, then locate its own manifest without another package
    // lookup or a fallback to an unrelated workspace installation.
    let directory = dirname(await realpath(require.resolve(name)));
    let metadataPath: string | undefined;
    for (let depth = 0; depth < 8; depth++) {
      const candidate = join(directory, "package.json");
      const bytes = await readFile(candidate, "utf8").catch(() => {});
      if (bytes !== undefined && (JSON.parse(bytes) as { name?: string }).name === name) {
        metadataPath = candidate;
        break;
      }
      directory = dirname(directory);
    }
    assert.ok(metadataPath !== undefined);
    const original = dirname(metadataPath);
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
      name: string;
      version: string;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    assert.equal(metadata.name, name);
    assert.equal(metadata.version, versions[name]);
    assert.ok(lock.includes("\n  " + name + "@" + metadata.version + ":"));
    const copy = join(work, "dependencies", name);
    const files = await fileTree(original);
    requirements.set(name, { original, copy, metadata, files });
    for (const dependency of Object.keys({
      ...metadata.dependencies,
      ...metadata.optionalDependencies,
      ...(name === "pg-pool" ? metadata.peerDependencies : {}),
    })) {
      await collect(dependency, metadataPath);
    }
  }
  await collect("pg", initial.resolve("pg"));
  assert.deepEqual([...requirements.keys()].toSorted(), Object.keys(versions).toSorted());
  const dependencies: Dependency[] = [];
  for (const [name, item] of requirements) {
    for (const file of Object.keys(item.files)) {
      const path = join(item.copy, file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, await readFile(join(item.original, file)), { mode: 0o400 });
    }
    assert.deepEqual(await fileTree(item.copy), item.files);
    const links: Record<string, string> = {};
    for (const dependency of Object.keys({
      ...item.metadata.dependencies,
      ...item.metadata.optionalDependencies,
      ...(name === "pg-pool" ? item.metadata.peerDependencies : {}),
    })) {
      const target = requirements.get(dependency);
      assert.ok(target);
      const link = join(item.copy, "node_modules", dependency);
      await mkdir(dirname(link), { recursive: true });
      await symlink(target.copy, link, "dir");
      links[dependency] = target.copy;
    }
    dependencies.push({
      name,
      version: item.metadata.version,
      root: item.copy,
      files: item.files,
      links,
    });
  }
  const pg = requirements.get("pg");
  assert.ok(pg);
  return { dependencies, pgEntry: join(pg.copy, relative(pg.original, initial.resolve("pg"))) };
}
async function snapshotTables(pool: Pool, consumer: string) {
  const result: GatewayRollbackCase["tables"] = [];
  for (const table of [
    "ag_kernel.operations",
    "ag_kernel.candidates",
    "ag_management.candidate_journal",
    "ag_management.physical_mappings",
  ]) {
    const rows = (
      await pool.query<{ body: string }>(
        `SELECT to_jsonb(source_row)::text AS body FROM ${table} source_row WHERE consumer=$1 ORDER BY 1 LIMIT 4097`,
        [consumer],
      )
    ).rows;
    assert.ok(rows.length <= 4096);
    assert.ok(rows.every((row) => Buffer.byteLength(row.body) <= 4 * 1024 * 1024));
    result.push({
      table,
      rows: rows.length,
      sha256: digest(canonical(rows.map((row) => row.body))),
    });
  }
  return result;
}
export async function prepareGatewayRollbackReader(input: {
  readerRoot: string;
  rrRoot: string;
  workRoot: string;
  output: string;
  databaseURL: string;
}) {
  const writerRoot = await realpath(fileURLToPath(new URL("../../../../../", import.meta.url)));
  const readerRoot = await realpath(input.readerRoot);
  assert.notEqual(readerRoot, writerRoot);
  for (const path of [readerRoot, input.rrRoot, input.workRoot, input.output]) {
    assert.ok(isAbsolute(path));
  }
  const git = (args: string[]) =>
    execFileSync("git", ["-c", "safe.directory=" + readerRoot, "-C", readerRoot, ...args], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
  assert.equal(git(["rev-parse", "HEAD"]), gatewayCompatibleFloor);
  assert.equal(git(["status", "--porcelain", "--untracked-files=all"]), "");
  const lock = await readFile(join(readerRoot, "pnpm-lock.yaml"));
  const writerLock = await readFile(join(writerRoot, "pnpm-lock.yaml"));
  const runtimeClosure = runtimeLockClosure(lock.toString("utf8"));
  assert.deepEqual(runtimeLockClosure(writerLock.toString("utf8")), runtimeClosure);
  const work = await mkdtemp(join(input.workRoot, "gateway-old-reader-"));
  try {
    const pg = await isolatedPostgresDependencies(work, lock.toString("utf8"));
    const sdkRequire = createRequire(join(writerRoot, "packages/account-gateway/package.json"));
    const zodMetadata = await realpath(sdkRequire.resolve("zod/package.json"));
    const zodRoot = dirname(zodMetadata);
    const zod = JSON.parse(await readFile(zodMetadata, "utf8")) as { version: string };
    assert.equal(zod.version, "4.6.7");
    assert.ok(lock.toString("utf8").includes("\n  zod@4.6.7:"));
    const rrRequire = createRequire(join(input.rrRoot, "package.json"));
    const esbuildRequire = createRequire(rrRequire.resolve("esbuild/package.json"));
    const esbuild = esbuildRequire.resolve("@esbuild/linux-x64/bin/esbuild");
    assert.equal(digest(await readFile(esbuild)), esbuildSHA256);
    const bundle = join(work, "old-reader.mjs"),
      metadata = join(work, "old-reader-meta.json");
    const sourceEntry = [
      'export { PostgresKernel } from "./services/account-gateway/src/postgres.ts";',
      'export { PostgresManagementStore, IntentSecrets } from "./services/account-gateway/src/management-store.ts";',
    ].join("\n");
    execFileSync(
      esbuild,
      [
        "--bundle",
        "--platform=node",
        "--target=node26",
        "--format=esm",
        "--tree-shaking=false",
        "--loader=ts",
        "--outfile=" + bundle,
        "--metafile=" + metadata,
        "--alias:@agent-teams/account-gateway/contracts=" +
          join(readerRoot, "packages/account-gateway/src/contracts/index.ts"),
        "--alias:zod=" + sdkRequire.resolve("zod"),
        "--log-level=silent",
      ],
      { cwd: readerRoot, input: sourceEntry, timeout: 15_000, stdio: ["pipe", "pipe", "pipe"] },
    );
    const graph = JSON.parse(await readFile(metadata, "utf8")) as {
      inputs: Record<string, unknown>;
      outputs: Record<string, { imports: { path: string; external?: boolean }[] }>;
    };
    const sourceFiles: Record<string, string> = {};
    for (const name of Object.keys(graph.inputs)) {
      if (name === "<stdin>") {
        continue;
      }
      const absolute = resolvePath(readerRoot, name);
      assert.equal(await realpath(absolute), absolute);
      const old = relative(readerRoot, absolute),
        dependency = relative(zodRoot, absolute);
      const source =
        /^(?:services\/account-gateway\/src|packages\/account-gateway\/src)\/.+\.ts$/.test(old);
      assert.ok(
        source || (!dependency.startsWith("..") && !isAbsolute(dependency)),
        "old reader cannot resolve current workspace code",
      );
      sourceFiles[source ? "old/" + old : "zod/" + dependency] = digest(await readFile(absolute));
    }
    assert.ok(Object.keys(sourceFiles).some((name) => name.endsWith("/postgres.ts")));
    assert.ok(Object.keys(sourceFiles).some((name) => name.endsWith("/management-records.ts")));
    for (const output of Object.values(graph.outputs)) {
      assert.ok(
        output.imports.every((entry) => entry.external === true && entry.path.startsWith("node:")),
        "all nonbuiltin dependencies must be bundled",
      );
    }
    const bundleSHA256 = digest(await readFile(bundle));
    const dependencySHA256 = digest(
      canonical(
        pg.dependencies
          .map(({ name, version, files }) => ({ name, version, files }))
          .toSorted((a, b) => a.name.localeCompare(b.name)),
      ),
    );
    const build = {
      contract: "gateway-native-connection-old-reader-build/v1",
      readerSHA: gatewayCompatibleFloor,
      readerTree: git(["rev-parse", "HEAD^{tree}"]),
      esbuildSHA256,
      bundleSHA256,
      dependencySHA256,
      lockfileSHA256: digest(lock),
      writerLockfileSHA256: digest(writerLock),
      runtimeLockClosureSHA256: digest(canonical(runtimeClosure)),
      oldSourceGraphSHA256: digest(canonical(sourceFiles)),
      sourceFiles,
    };
    await writeFile(
      join(input.output, "gateway-old-reader-build.json"),
      JSON.stringify(build, null, 2) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    const cases: GatewayRollbackCase[] = [];
    return {
      build,
      cases,
      async probe(
        state: GatewayRollbackCase["gatewayState"],
        context: {
          consumerId: string;
          operationId: string;
          pool: Pool;
          kernel: PostgresKernel;
          store: PostgresManagementStore;
        },
      ) {
        const trusted = { consumerId: context.consumerId };
        const operation = await context.kernel.operation(trusted, context.operationId);
        const journal = await context.store.readJournal(trusted, context.operationId);
        assert.equal(operation.state, state);
        assert.ok(operation.connection && journal?.connectionSnapshot);
        assert.deepEqual(operation.connection.connection, journal.connectionSnapshot.connection);
        const mapping = await context.store.mapping(trusted, journal.generation);
        assert.equal(mapping !== undefined, state === "applied");
        if (mapping) {
          assert.deepEqual(
            mapping.descriptor.publication?.connection,
            operation.connection.connection,
          );
        }
        const expected: GatewayRollbackCase = {
          gatewayState: state,
          nativeStateEvidence:
            state === "pending"
              ? "prepared"
              : state === "applied"
                ? "completed"
                : "unknown_after_entered_exchange",
          operationSHA256: digest(canonical(operation)),
          journalSHA256: digest(canonical(journal)),
          mappingSHA256: digest(canonical(mapping ?? null)),
          bindingSHA256: digest(canonical(operation.connection)),
          tables: await snapshotTables(context.pool, context.consumerId),
          oldReaderPreserved: true,
          durableTablesUnchanged: true,
        };
        const output = join(work, state + "-receipt.json"),
          specification = join(work, state + "-input.json");
        const spec: GatewayRollbackInput = {
          contract: "gateway-native-connection-old-reader/v1",
          readerSHA: gatewayCompatibleFloor,
          bundle,
          bundleSHA256,
          ...pg,
          databaseURL: input.databaseURL,
          consumerId: context.consumerId,
          operationId: context.operationId,
          expected,
          output,
        };
        await writeFile(specification, JSON.stringify(spec), { mode: 0o600, flag: "wx" });
        try {
          const child = spawn(
            process.execPath,
            [fileURLToPath(new URL("./rollback-reader.ts", import.meta.url)), specification],
            {
              cwd: work,
              env: { PATH: process.env.PATH, PGPASSFILE: "/dev/null" },
              stdio: "ignore",
            },
          );
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
          }, 20_000);
          const status = await new Promise<number | null>((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", resolve);
          }).finally(() => {
            clearTimeout(timer);
          });
          assert.equal(status, 0, "exact old Gateway reader failed");
          const receipt = JSON.parse(await readFile(output, "utf8")) as {
            readerSHA: string;
            bundleSHA256: string;
            result: GatewayRollbackCase;
          };
          assert.equal(receipt.readerSHA, gatewayCompatibleFloor);
          assert.equal(receipt.bundleSHA256, bundleSHA256);
          assert.deepEqual(receipt.result, expected);
          assert.deepEqual(await snapshotTables(context.pool, context.consumerId), expected.tables);
          cases.push(expected);
          return expected;
        } finally {
          await rm(specification, { force: true });
          await rm(output, { force: true });
        }
      },
      close: () => rm(work, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(work, { recursive: true, force: true });
    throw error;
  }
}
