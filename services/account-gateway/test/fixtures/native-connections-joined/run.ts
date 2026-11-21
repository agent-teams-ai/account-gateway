/** Reproducible source-qualified Native -> Gateway -> packed SDK -> RR fixture.
 * Owns one disposable PostgreSQL cluster and never opens a configured database.
 * Run with the pinned RR tsx loader; all three checkout SHAs are mandatory. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import {
  chmod,
  chown,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

type Options = {
  gatewayRoot: string;
  gatewayCommit: string;
  nativeRoot: string;
  nativeCommit: string;
  rrRoot: string;
  rrCommit: string;
  sdkArchive: string;
  sdkSHA256: string;
  pgBin: string;
  go: string;
  output: string;
};
const flags = new Map([
  ["--gateway-root", "gatewayRoot"],
  ["--gateway-commit", "gatewayCommit"],
  ["--native-root", "nativeRoot"],
  ["--native-commit", "nativeCommit"],
  ["--rr-root", "rrRoot"],
  ["--rr-commit", "rrCommit"],
  ["--sdk-archive", "sdkArchive"],
  ["--sdk-sha256", "sdkSHA256"],
  ["--pg-bin", "pgBin"],
  ["--go", "go"],
  ["--output", "output"],
]);
const report = (value: object) => process.stdout.write(JSON.stringify(value) + "\n");
const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
let phase = "arguments";
let output: string | undefined;
let pgData: string | undefined;
let pgBin: string | undefined;
let pgStarted = false;
let pgStartAttempted = false;
let owned: string | undefined;
let pgUID: number | undefined;
let qualification: Record<string, unknown> | undefined;

function smallCommand(binary: string, args: string[], cwd?: string): string {
  const result = spawnSync(binary, args, {
    cwd,
    env: { ...process.env, GOTOOLCHAIN: "local" },
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 4 << 20,
  });
  assert.equal(result.status, 0, "qualified fixture command failed");
  assert.equal(result.error, undefined);
  return result.stdout.trim();
}
function cleanPin(root: string, commit: string): void {
  assert.match(commit, /^[a-f0-9]{40}$/);
  // The isolated container runs as root over read-only host-owned checkouts.
  // Trust only this explicitly pinned directory for these Git invocations.
  const git = ["-c", "safe.directory=" + root];
  assert.equal(smallCommand("git", [...git, "rev-parse", "HEAD"], root), commit);
  assert.equal(
    smallCommand("git", [...git, "status", "--porcelain", "--untracked-files=all"], root),
    "",
    "source qualification requires a clean exact checkout",
  );
}
async function command(
  binary: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  log: string,
  timeoutMs: number,
  uid?: number,
): Promise<number> {
  const fd = openSync(log, "wx", 0o600);
  try {
    const child = spawn(binary, args, {
      cwd,
      env,
      uid,
      gid: uid,
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    const terminate = (signal: NodeJS.Signals) => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
        } catch {
          /* Already reaped. */
        }
      }
    };
    let force: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      terminate("SIGTERM");
      force = setTimeout(() => terminate("SIGKILL"), 5000);
    }, timeoutMs);
    try {
      return await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => resolve(timedOut ? 124 : (code ?? 1)));
      });
    } finally {
      clearTimeout(timer);
      if (timedOut) terminate("SIGKILL");
      clearTimeout(force);
    }
  } finally {
    closeSync(fd);
  }
}
async function availablePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  assert.ok(address && typeof address === "object" && address.port !== 5432);
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
async function main() {
  const values: Record<string, string> = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = flags.get(process.argv[i]),
      value = process.argv[i + 1];
    assert.ok(key && value && !(key in values), "unknown, repeated, or missing option");
    values[key] = value;
  }
  assert.equal(Object.keys(values).length, flags.size);
  const options = values as Options;
  for (const path of [
    options.gatewayRoot,
    options.nativeRoot,
    options.rrRoot,
    options.sdkArchive,
    options.pgBin,
    options.go,
    options.output,
  ])
    assert.ok(isAbsolute(path));
  assert.match(options.sdkSHA256, /^[a-f0-9]{64}$/);
  assert.equal(process.platform, "linux");
  assert.equal(process.versions.node, "26.11.1");
  phase = "clean-source-provenance";
  const roots = [
    [await realpath(options.gatewayRoot), options.gatewayCommit],
    [await realpath(options.nativeRoot), options.nativeCommit],
    [await realpath(options.rrRoot), options.rrCommit],
  ] as const;
  for (const [root, commit] of roots) cleanPin(root, commit);
  assert.equal(sha256(await readFile(options.sdkArchive)), options.sdkSHA256);
  const actionArchive = process.env.RR_PROVIDER_JOINED_ACTION_ARCHIVE;
  const codexBinary = process.env.RR_PROVIDER_JOINED_CODEX_BINARY;
  assert.ok(actionArchive && codexBinary && isAbsolute(actionArchive) && isAbsolute(codexBinary));
  assert.equal(
    sha256(await readFile(actionArchive)),
    "42e8d844bd451655ff171dc4093a872fc471675c90b3997697261ba4153807b4",
  );
  assert.equal(
    sha256(await readFile(codexBinary)),
    "524396258c974948334eabe6f2c6b1d8e1979dfd048d67d535ad9e4550fa5b26",
  );
  assert.match(smallCommand(options.go, ["version"]), /^go version go1\.27\.4 /);
  assert.match(
    smallCommand(join(options.pgBin, "postgres"), ["--version"]),
    /^postgres \(PostgreSQL\) 17\.10(?: \([^)]+\))?$/,
  );
  const requestedOutput = resolve(options.output);
  output = join(await realpath(dirname(requestedOutput)), basename(requestedOutput));
  for (const [root] of roots) {
    const child = relative(root, output);
    assert.ok(child.startsWith("../"), "evidence must be outside qualified source checkouts");
  }
  // Creation is exclusive: a failed qualification can never become a new pass
  // by reusing a previous database, log, receipt, or compiled test binary.
  await mkdir(output, { mode: 0o700 });
  qualification = {
    contract: "native-connections-joined-qualification/v1",
    qualified: false,
    nativeCommit: options.nativeCommit,
    gatewayCommit: options.gatewayCommit,
    rrCommit: options.rrCommit,
    sdkSHA256: options.sdkSHA256,
    expectedInventoryRows: 53,
    batches: [],
  };
  owned = await mkdtemp("/tmp/gateway-native-connections-");
  await chmod(owned, 0o755);
  const temp = join(owned, "tmp"),
    sdkRoot = join(owned, "sdk"),
    runtimeWork = join(owned, "review-work"),
    goCache = join(owned, "go-cache");
  await mkdir(temp, { mode: 0o700 });
  await mkdir(sdkRoot, { mode: 0o700 });
  await mkdir(runtimeWork, { mode: 0o700 });
  await mkdir(goCache, { mode: 0o700 });
  const entries = smallCommand("tar", ["-tzf", options.sdkArchive]).split("\n");
  assert.ok(entries.length > 10);
  for (const entry of entries) {
    assert.match(entry, /^package\/[a-zA-Z0-9_.\/-]+$/);
    assert.equal(entry.split("/").includes(".."), false);
  }
  smallCommand("tar", ["-xzf", options.sdkArchive, "--strip-components=1", "-C", sdkRoot]);
  const requireRR = createRequire(join(options.rrRoot, "package.json"));
  const loader = requireRR.resolve("tsx");
  const runner = join(
    options.gatewayRoot,
    "services/account-gateway/test/native-connections-joined.ts",
  );
  const fixture = join(
    options.nativeRoot,
    "backend/internal/gatewaybootstrap/native_connection_http_postgres_test.go",
  );
  const binary = join(owned, "native-connections-joined.test");
  const sources = {
    nativeFixtureSHA256: sha256(await readFile(fixture)),
    runnerSHA256: sha256(await readFile(runner)),
    driverSHA256: sha256(await readFile(new URL(import.meta.url))),
    loaderSHA256: sha256(await readFile(loader)),
    consumerLoaderSHA256: sha256(await readFile(new URL("./consumers.ts", import.meta.url))),
  };
  Object.assign(qualification, sources);
  const inheritedGitConfigCount = Number(process.env.GIT_CONFIG_COUNT ?? "0");
  assert.ok(
    Number.isSafeInteger(inheritedGitConfigCount) &&
      inheritedGitConfigCount >= 0 &&
      inheritedGitConfigCount <= 64,
  );
  const environment = {
    ...process.env,
    GOTOOLCHAIN: "local",
    GOMAXPROCS: "1",
    GOMEMLIMIT: "1000MiB",
    GOGC: "30",
    GOCACHE: goCache,
    GIT_CONFIG_COUNT: String(inheritedGitConfigCount + 1),
    ["GIT_CONFIG_KEY_" + inheritedGitConfigCount]: "safe.directory",
    ["GIT_CONFIG_VALUE_" + inheritedGitConfigCount]: roots[1][0],
    // The isolated CI container supplies its already downloaded and verified
    // read-only module cache. Missing dependencies fail, without disabling sumdb.
    GOPROXY: "off",
    TMPDIR: temp,
    GIN_MODE: "release",
    RR_PROVIDER_JOINED_WORK_ROOT: runtimeWork,
    PGPASSFILE: "/dev/null",
  };
  phase = "native-bootstrap-compile";
  report({ phase });
  const compile = await command(
    options.go,
    [
      "test",
      "-c",
      "-o",
      binary,
      "-p",
      "1",
      "-vet=off",
      "-mod=readonly",
      "-buildvcs=true",
      "-tags",
      "gatewaycustody",
      "-gcflags=github.com/Wei-Shaw/sub2api/ent=-l -c=1",
      "-gcflags=github.com/Wei-Shaw/sub2api/internal/service=-N -l -c=1",
      "./internal/gatewaybootstrap",
    ],
    join(options.nativeRoot, "backend"),
    environment,
    join(output, "compile.log"),
    30 * 60_000,
  );
  assert.equal(compile, 0, "native bootstrap compilation failed; see compile.log");
  for (const [root, commit] of roots) cleanPin(root, commit);
  await writeFile(
    join(output, "build.json"),
    JSON.stringify(
      {
        contract: "native-connections-joined-build/v1",
        ...sources,
        nativeCommit: options.nativeCommit,
        gatewayCommit: options.gatewayCommit,
        rrCommit: options.rrCommit,
        sdkSHA256: options.sdkSHA256,
        binarySHA256: sha256(await readFile(binary)),
        goVersion: "go1.27.4",
        nodeVersion: process.versions.node,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  phase = "fresh-postgresql";
  pgBin = options.pgBin;
  pgData = join(owned, "postgres-data");
  pgUID = process.getuid?.() === 0 ? 65534 : undefined;
  await mkdir(pgData, { mode: 0o700 });
  if (pgUID !== undefined) await chown(pgData, pgUID, pgUID);
  const port = await availablePort();
  assert.equal(
    await command(
      join(pgBin, "initdb"),
      ["-D", pgData, "-U", "postgres", "-A", "trust", "--no-locale", "--encoding=UTF8"],
      owned,
      environment,
      join(output, "postgres-init.log"),
      30_000,
      pgUID,
    ),
    0,
  );
  pgStartAttempted = true;
  assert.equal(
    await command(
      join(pgBin, "pg_ctl"),
      [
        "-D",
        pgData,
        "-w",
        "-t",
        "15",
        "-l",
        join(pgData, "postgres.log"),
        "-o",
        `-h 127.0.0.1 -p ${port} -c unix_socket_directories='' -c max_connections=60 -c shared_buffers=32MB -c work_mem=4MB`,
        "start",
      ],
      owned,
      environment,
      join(output, "postgres-start.log"),
      20_000,
      pgUID,
    ),
    0,
  );
  pgStarted = true;
  const dsn = (database: string) =>
    `postgresql://postgres@127.0.0.1:${port}/${database}?sslmode=disable`;
  const batches: {
    batch: string;
    exitCode: number;
    receipt?: {
      qualified: boolean;
      expectedInventoryRows: number;
      batchRows: number;
      rows: { rowId: string; enrolled: boolean; outcome: string }[];
      passed: number;
      failed: number;
      blocked: number;
      enrolled: number;
      reviewPassed: number;
    };
  }[] = [];
  for (const batch of ["standard", "express"] as const) {
    const nativeDatabase = "native_connection_joined_" + batch;
    const gatewayDatabase = "ag_kernel_test_connections_joined_" + batch;
    for (const database of [nativeDatabase, gatewayDatabase])
      smallCommand(join(pgBin, "createdb"), [
        "-h",
        "127.0.0.1",
        "-p",
        String(port),
        "-U",
        "postgres",
        database,
      ]);
    const batchOutput = join(output, batch);
    await mkdir(batchOutput, { mode: 0o700 });
    phase = "actual-native-gateway-sdk-rr-" + batch;
    report({ phase });
    const result = await command(
      binary,
      [
        "-test.run",
        "^TestNativeConnectionsJoinedPrivateHTTPPostgres$",
        "-test.v",
        "-test.timeout",
        "35m",
      ],
      join(options.nativeRoot, "backend"),
      {
        ...environment,
        AG_NATIVE_CONNECTION_JOINED_ALLOW: "disposable_pg17_10",
        GATEWAY_NATIVE_CONNECTION_JOINED_BATCH: batch,
        GATEWAY_NATIVE_CONNECTION_JOINED_DSN: dsn(nativeDatabase),
        AG_NATIVE_CONNECTION_JOINED_KERNEL_DSN: dsn(gatewayDatabase),
        GATEWAY_NATIVE_CONNECTION_JOINED_RUNNER: runner,
        GATEWAY_NATIVE_CONNECTION_JOINED_RUNNER_SHA256: sources.runnerSHA256,
        GATEWAY_NATIVE_CONNECTION_JOINED_NODE: process.execPath,
        GATEWAY_NATIVE_CONNECTION_JOINED_LOADER: loader,
        GATEWAY_NATIVE_CONNECTION_JOINED_ARTIFACTS: batchOutput,
        AG_NATIVE_CONNECTION_JOINED_SDK_TGZ: options.sdkArchive,
        AG_NATIVE_CONNECTION_JOINED_SDK_ROOT: sdkRoot,
        AG_NATIVE_CONNECTION_JOINED_SDK_SHA256: options.sdkSHA256,
        RR_NATIVE_CONNECTION_JOINED_ROOT: options.rrRoot,
      },
      join(batchOutput, "native-joined.log"),
      36 * 60_000,
    );
    const item: (typeof batches)[number] = { batch, exitCode: result };
    batches.push(item);
    try {
      const receipt = JSON.parse(
        await readFile(join(batchOutput, "gateway-rr-receipt.json"), "utf8"),
      ) as NonNullable<typeof item.receipt>;
      assert.equal(receipt.expectedInventoryRows, 53);
      assert.equal(receipt.batchRows, batch === "standard" ? 52 : 1);
      assert.equal(receipt.rows.length, receipt.batchRows);
      assert.equal(new Set(receipt.rows.map((row) => row.rowId)).size, receipt.batchRows);
      item.receipt = receipt;
    } catch {
      item.exitCode = item.exitCode || 1;
    }
    // Failure in standard must not silently drop the separate Vertex Express row.
    for (const [root, commit] of roots) cleanPin(root, commit);
    await rm(join(batchOutput, "private-fixture.json"), { force: true });
    await rm(join(batchOutput, "private-exchange.json"), { force: true });
  }
  const rows = batches.flatMap((batch) => batch.receipt?.rows ?? []);
  const qualified =
    batches.every((batch) => batch.exitCode === 0 && batch.receipt?.qualified === true) &&
    rows.length === 53 &&
    new Set(rows.map((row) => row.rowId)).size === 53 &&
    rows.every((row) => row.outcome === "passed");
  qualification = {
    contract: "native-connections-joined-qualification/v1",
    qualified,
    nativeCommit: options.nativeCommit,
    gatewayCommit: options.gatewayCommit,
    rrCommit: options.rrCommit,
    sdkSHA256: options.sdkSHA256,
    ...sources,
    expectedInventoryRows: 53,
    enrolled: rows.filter((row) => row.enrolled).length,
    passed: rows.filter((row) => row.outcome === "passed").length,
    blocked: rows.filter((row) => row.outcome === "blocked").length,
    batches: batches.map(({ batch, exitCode, receipt }) => ({
      batch,
      exitCode,
      qualified: receipt?.qualified ?? false,
      passed: receipt?.passed ?? 0,
      failed: receipt?.failed ?? 0,
      blocked: receipt?.blocked ?? 0,
      enrolled: receipt?.enrolled ?? 0,
      reviewPassed: receipt?.reviewPassed ?? 0,
    })),
  };
  if (!qualified) process.exitCode = 1;
}
try {
  await main();
} catch (error) {
  report({ phase: "failed", at: phase, error: error instanceof Error ? error.name : "failure" });
  if (qualification)
    qualification.failure = { at: phase, code: error instanceof Error ? error.name : "failure" };
  process.exitCode = 1;
} finally {
  let postgresStopped = !pgStartAttempted;
  try {
    if (pgData && pgBin && output && owned && pgStartAttempted) {
      // pg_ctl can time out after spawning the server. A failed start still
      // owns that cluster and must establish that it stopped before deletion.
      const status = pgStarted
        ? 0
        : await command(
            join(pgBin, "pg_ctl"),
            ["-D", pgData, "status"],
            owned,
            process.env,
            join(output, "postgres-status.log"),
            10_000,
            pgUID,
          );
      postgresStopped = status === 3;
      if (status === 0) {
        postgresStopped =
          (await command(
            join(pgBin, "pg_ctl"),
            ["-D", pgData, "-w", "-t", "15", "-m", "fast", "stop"],
            owned,
            process.env,
            join(output, "postgres-stop.log"),
            20_000,
            pgUID,
          )) === 0;
        if (!postgresStopped)
          postgresStopped =
            (await command(
              join(pgBin, "pg_ctl"),
              ["-D", pgData, "-w", "-t", "15", "-m", "immediate", "stop"],
              owned,
              process.env,
              join(output, "postgres-stop-immediate.log"),
              20_000,
              pgUID,
            )) === 0;
      }
      await copyFile(join(pgData, "postgres.log"), join(output, "postgres.log")).catch(() => {});
    }
  } catch {
    postgresStopped = false;
  }
  if (!postgresStopped) process.exitCode = 1;
  // Private cluster data, compiled binaries and CLI workspaces live in the
  // owned /tmp directory, outside the allowlisted CI evidence directory.
  if (owned && postgresStopped) await rm(owned, { recursive: true, force: true });
  if (qualification && output) {
    qualification.postgresStopped = postgresStopped;
    qualification.qualified = qualification.qualified === true && postgresStopped;
    qualification.exitCode = process.exitCode ?? 0;
    await writeFile(join(output, "run.json"), JSON.stringify(qualification, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    report({
      phase: qualification.failure ? "failed" : qualification.qualified ? "completed" : "blocked",
      ...qualification,
    });
  }
}
