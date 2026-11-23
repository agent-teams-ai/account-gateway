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
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import {
  acceptedBaselineRows,
  baselineRowIds,
  hasNativeSourcePostconditions,
} from "./acceptance.ts";

type Options = {
  gatewayRoot: string;
  gatewayCommit: string;
  gatewayReaderRoot: string;
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
const extensionOracle = {
  rowId: "fixture-native-extension-responses-v1/fixture_browser_v1/same_consumer_build",
  profileId: "fixture-native-extension-responses-v1",
  providerId: "fixture-native-extension",
  methodId: "fixture_browser_v1",
} as const;
// One native compilation is shared by all batches. The extension receives
// three minutes including its process startup; it is not another 36min matrix.
const timeBudget = {
  nativeCompileMilliseconds: 30 * 60_000,
  baselineBatchMilliseconds: 36 * 60_000,
  baselineBatchCount: 2,
  extensionBatchMilliseconds: 3 * 60_000,
  sharedStartupCleanupMilliseconds: 3 * 60_000,
  totalUpperBoundMilliseconds: 108 * 60_000,
} as const;
const flags = new Map([
  ["--gateway-root", "gatewayRoot"],
  ["--gateway-commit", "gatewayCommit"],
  ["--gateway-reader-root", "gatewayReaderRoot"],
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
const pgState = { started: false, startAttempted: false };
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
    const timeout = { expired: false };
    const timer = setTimeout(() => {
      timeout.expired = true;
      terminate("SIGTERM");
      force = setTimeout(() => {
        terminate("SIGKILL");
      }, 5000);
    }, timeoutMs);
    try {
      return await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => {
          resolve(timeout.expired ? 124 : (code ?? 1));
        });
      });
    } finally {
      clearTimeout(timer);
      if (timeout.expired) {
        terminate("SIGKILL");
      }
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
  assert.ok(address !== null && typeof address === "object" && address.port !== 5432);
  await new Promise<void>((resolve, reject) => {
    listener.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  return address.port;
}
async function main() {
  const values: Record<string, string> = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = flags.get(process.argv[i]),
      value = process.argv.at(i + 1);
    assert.ok(
      key !== undefined && value !== undefined && value.length > 0 && !(key in values),
      "unknown, repeated, or missing option",
    );
    values[key] = value;
  }
  assert.equal(Object.keys(values).length, flags.size);
  const options = values as Options;
  for (const path of [
    options.gatewayRoot,
    options.gatewayReaderRoot,
    options.nativeRoot,
    options.rrRoot,
    options.sdkArchive,
    options.pgBin,
    options.go,
    options.output,
  ]) {
    assert.ok(isAbsolute(path));
  }
  assert.match(options.sdkSHA256, /^[a-f0-9]{64}$/);
  assert.equal(process.platform, "linux");
  assert.equal(process.versions.node, "26.11.1");
  phase = "source-roots";
  const roots = [
    [await realpath(options.gatewayRoot), options.gatewayCommit],
    [await realpath(options.nativeRoot), options.nativeCommit],
    [await realpath(options.rrRoot), options.rrCommit],
  ] as const;
  const gatewayReaderRoot = await realpath(options.gatewayReaderRoot);
  phase = "evidence-directory";
  const requestedOutput = resolvePath(options.output);
  output = join(await realpath(dirname(requestedOutput)), basename(requestedOutput));
  for (const root of [...roots.map(([path]) => path), gatewayReaderRoot]) {
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
    expectedExtensionRows: 1,
    timeBudget,
    batches: [],
  };
  // Initialize bounded evidence before validating toolchains and source pins.
  // A failed prerequisite still records its closed phase, without retaining
  // Git output, environment values, child stderr, or assertion diffs.
  const sourcePhases = ["gateway-source-pin", "native-source-pin", "rr-source-pin"] as const;
  for (const [index, [root, commit]] of roots.entries()) {
    phase = sourcePhases[index];
    cleanPin(root, commit);
  }
  phase = "gateway-reader-source-pin";
  cleanPin(gatewayReaderRoot, "bcfcde2d06d7bbdb941258e1908986b9f5718feb");
  phase = "native-baseline-inventory";
  const baselineInventory = await readFile(
    join(
      options.nativeRoot,
      "backend/internal/gatewaybootstrap/testdata/native_connection_g0_rows.json",
    ),
  );
  const expectedBaselineRowIds = baselineRowIds(
    JSON.parse(baselineInventory.toString("utf8")) as unknown,
  );
  phase = "sdk-archive-provenance";
  assert.equal(sha256(await readFile(options.sdkArchive)), options.sdkSHA256);
  const actionArchive = process.env.RR_PROVIDER_JOINED_ACTION_ARCHIVE;
  const codexBinary = process.env.RR_PROVIDER_JOINED_CODEX_BINARY;
  phase = "review-runtime-configuration";
  assert.ok(
    actionArchive !== undefined &&
      codexBinary !== undefined &&
      isAbsolute(actionArchive) &&
      isAbsolute(codexBinary),
  );
  phase = "action-archive-provenance";
  assert.equal(
    sha256(await readFile(actionArchive)),
    "42e8d844bd451655ff171dc4093a872fc471675c90b3997697261ba4153807b4",
  );
  phase = "codex-binary-provenance";
  assert.equal(
    sha256(await readFile(codexBinary)),
    "524396258c974948334eabe6f2c6b1d8e1979dfd048d67d535ad9e4550fa5b26",
  );
  phase = "go-toolchain";
  assert.match(smallCommand(options.go, ["version"]), /^go version go1\.27\.4 /);
  phase = "postgres-toolchain";
  assert.match(
    smallCommand(join(options.pgBin, "postgres"), ["--version"]),
    /^postgres \(PostgreSQL\) 17\.10(?: \([^)]+\))?$/,
  );
  phase = "fixture-workspace";
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
    assert.match(entry, /^package\/[a-zA-Z0-9_./-]+$/);
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
    acceptanceSHA256: sha256(await readFile(new URL("./acceptance.ts", import.meta.url))),
    baselineInventorySHA256: sha256(baselineInventory),
    loaderSHA256: sha256(await readFile(loader)),
    consumerLoaderSHA256: sha256(await readFile(new URL("./consumers.ts", import.meta.url))),
    rollbackLoaderSHA256: sha256(await readFile(new URL("./rollback.ts", import.meta.url))),
    rollbackReaderSHA256: sha256(await readFile(new URL("./rollback-reader.ts", import.meta.url))),
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
    // The actual RR base configuration owns JSX for both apps/web and its
    // workspace UI packages. Apply it before the loader registers any module,
    // with identical settings for the known and newly discovered providers.
    TSX_TSCONFIG_PATH: join(options.rrRoot, "tsconfig.base.json"),
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
      "gatewaycustody,gatewayextension",
      "-gcflags=github.com/Wei-Shaw/sub2api/ent=-l -c=1",
      "-gcflags=github.com/Wei-Shaw/sub2api/internal/service=-N -l -c=1",
      "./internal/gatewaybootstrap",
    ],
    join(options.nativeRoot, "backend"),
    environment,
    join(output, "compile.log"),
    timeBudget.nativeCompileMilliseconds,
  );
  assert.equal(compile, 0, "native bootstrap compilation failed; see compile.log");
  for (const [root, commit] of roots) {
    cleanPin(root, commit);
  }
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
        timeBudget,
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
  if (pgUID !== undefined) {
    await chown(pgData, pgUID, pgUID);
  }
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
  pgState.startAttempted = true;
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
  pgState.started = true;
  const dsn = (database: string) =>
    `postgresql://postgres@127.0.0.1:${port}/${database}?sslmode=disable`;
  const batches: {
    batch: string;
    exitCode: number;
    sourcePostconditionsVerified: boolean;
    receipt?: {
      contract: string;
      qualified: boolean;
      expectedInventoryRows: number;
      expectedExtensionRows?: number;
      batchRows: number;
      rows: {
        rowId: string;
        enrolled: boolean;
        outcome: string;
        review: string;
        failure?: { at: string; error: string };
        pendingRecovery?: boolean;
      }[];
      discoveredProviders: { profileId: string; providerId: string; methodIds: string[] }[];
      consumerBuildDigestBefore: string;
      consumerBuildDigestAfter: string;
      passed: number;
      failed: number;
      blocked: number;
      enrolled: number;
      reviewPassed: number;
      gatewayCompatibility: {
        qualified: boolean;
        readerSHA?: string;
        bundleSHA256?: string;
        dependencySHA256?: string;
        oldSourceGraphSHA256?: string;
        cases: {
          gatewayState: string;
          durableTablesUnchanged: boolean;
          oldReaderPreserved: boolean;
        }[];
      };
      accountInfoCompatibility?: {
        qualified: boolean;
        sdkSourceCommit: string;
        archiveSHA256: string;
        bundleSHA256: string;
        oldSourceGraphSHA256: string;
        dependencySHA256: string;
        oldV1Contract: boolean;
        v2MethodAbsent: boolean;
        currentV2Read: boolean;
        oldV1Read: boolean;
        nativeFactsPreserved: boolean;
        identityPreserved: boolean;
        noV2Probe: boolean;
        factualProvenance: boolean;
      };
    };
  }[] = [];
  for (const batch of ["standard", "express", "extensibility"] as const) {
    const nativeDatabase = "native_connection_joined_" + batch;
    const gatewayDatabase = "ag_kernel_test_connections_joined_" + batch;
    for (const database of [nativeDatabase, gatewayDatabase]) {
      smallCommand(join(pgBin, "createdb"), [
        "-h",
        "127.0.0.1",
        "-p",
        String(port),
        "-U",
        "postgres",
        database,
      ]);
    }
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
        batch === "extensibility" ? "170s" : "35m",
      ],
      join(options.nativeRoot, "backend"),
      {
        ...environment,
        AG_NATIVE_CONNECTION_JOINED_ALLOW: "disposable_pg17_10",
        AG_NATIVE_CONNECTION_JOINED_GATEWAY_READER_ROOT: gatewayReaderRoot,
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
      batch === "extensibility"
        ? timeBudget.extensionBatchMilliseconds
        : timeBudget.baselineBatchMilliseconds,
    );
    const item: (typeof batches)[number] = {
      batch,
      exitCode: result,
      sourcePostconditionsVerified: false,
    };
    batches.push(item);
    try {
      const receipt = JSON.parse(
        await readFile(join(batchOutput, "gateway-rr-receipt.json"), "utf8"),
      ) as NonNullable<typeof item.receipt>;
      assert.equal(receipt.expectedInventoryRows, 53);
      assert.equal(receipt.batchRows, batch === "standard" ? 52 : 1);
      assert.equal(receipt.rows.length, receipt.batchRows);
      assert.equal(new Set(receipt.rows.map((row) => row.rowId)).size, receipt.batchRows);
      assert.match(receipt.consumerBuildDigestBefore, /^[a-f0-9]{64}$/);
      assert.equal(receipt.consumerBuildDigestAfter, receipt.consumerBuildDigestBefore);
      if (batch === "extensibility") {
        assert.equal(receipt.contract, "native-provider-extension-gateway-sdk-rr/v1");
        assert.equal(receipt.expectedExtensionRows, 1);
        assert.equal(receipt.rows[0].rowId, extensionOracle.rowId);
        assert.equal(receipt.rows[0].pendingRecovery, true);
        assert.deepEqual(receipt.discoveredProviders, [
          {
            profileId: extensionOracle.profileId,
            providerId: extensionOracle.providerId,
            methodIds: [extensionOracle.methodId],
          },
        ]);
      } else {
        assert.equal(receipt.contract, "native-connections-gateway-sdk-rr-joined/v1");
      }
      item.receipt = receipt;
      // Keep observed review rows even when the separate Native proof is absent.
      // A blocked child must still finish Native protocol and database checks.
      const sourceReceipt: unknown = JSON.parse(
        await readFile(join(batchOutput, "native-receipt.json"), "utf8"),
      );
      item.sourcePostconditionsVerified = hasNativeSourcePostconditions(sourceReceipt, {
        batch,
        runnerSHA256: sources.runnerSHA256,
        rowIds: receipt.rows.map((row) => row.rowId),
      });
      assert.ok(item.sourcePostconditionsVerified, "native terminal source checks incomplete");
    } catch {
      item.exitCode = item.exitCode || 1;
    }
    // A failed baseline batch must not drop Express or the independent
    // extensibility proof. Neither extension counts nor outcomes alter G0.
    for (const [root, commit] of roots) {
      cleanPin(root, commit);
    }
    await rm(join(batchOutput, "private-fixture.json"), { force: true });
    await rm(join(batchOutput, "private-exchange.json"), { force: true });
  }
  const baseline = batches.filter((batch) => batch.batch !== "extensibility");
  const nativeSourcePostconditionsVerified = batches.every(
    (batch) => batch.sourcePostconditionsVerified,
  );
  const extension = batches.find((batch) => batch.batch === "extensibility");
  const rows = baseline.flatMap((batch) => batch.receipt?.rows ?? []);
  const baselineQualified =
    baseline.every((batch) => batch.exitCode === 0 && batch.receipt?.qualified === true) &&
    acceptedBaselineRows(rows, expectedBaselineRowIds);
  const identity = baseline[0].receipt?.consumerBuildDigestBefore;
  const unchangedConsumerBuild =
    identity !== undefined &&
    batches.every(
      (batch) =>
        batch.receipt?.consumerBuildDigestBefore === identity &&
        batch.receipt.consumerBuildDigestAfter === identity,
    );
  const baselineCatalog = baseline.flatMap((batch) => batch.receipt?.discoveredProviders ?? []);
  const absentFromBaseline =
    rows.length === 53 &&
    baselineCatalog.length > 0 &&
    baselineCatalog.every(
      (profile) =>
        profile.profileId !== extensionOracle.profileId &&
        profile.providerId !== extensionOracle.providerId &&
        !profile.methodIds.includes(extensionOracle.methodId),
    );
  const extensionQualified =
    extension?.exitCode === 0 &&
    extension.receipt?.qualified === true &&
    extension.receipt.rows.length === 1 &&
    extension.receipt.rows[0].outcome === "passed" &&
    absentFromBaseline &&
    unchangedConsumerBuild;
  const readerReceipts = batches
    .filter((batch) => batch.batch !== "express")
    .map((batch) => batch.receipt?.gatewayCompatibility);
  const compatibilityCases = readerReceipts.flatMap((receipt) => receipt?.cases ?? []);
  const gatewayCompatibility = {
    readerSHA: "bcfcde2d06d7bbdb941258e1908986b9f5718feb",
    qualified:
      readerReceipts.every(
        (receipt) =>
          receipt?.qualified === true &&
          receipt.readerSHA === "bcfcde2d06d7bbdb941258e1908986b9f5718feb",
      ) &&
      JSON.stringify(compatibilityCases.map((entry) => entry.gatewayState).toSorted()) ===
        JSON.stringify(["applied", "pending", "unknown"]) &&
      compatibilityCases.every(
        (entry) => entry.durableTablesUnchanged && entry.oldReaderPreserved,
      ) &&
      new Set(readerReceipts.map((receipt) => receipt?.bundleSHA256)).size === 1 &&
      new Set(readerReceipts.map((receipt) => receipt?.dependencySHA256)).size === 1 &&
      new Set(readerReceipts.map((receipt) => receipt?.oldSourceGraphSHA256)).size === 1,
    cases: compatibilityCases,
  };
  const metadataProofs = batches.map((batch) => batch.receipt?.accountInfoCompatibility);
  const accountInfoCompatibility = {
    sdkSourceCommit: "f2690a3c9cfd0cf61bfb7ca31b802d249105d751",
    archiveSHA256: "34562d43668a1ca09e95666da3237206b3744d0d0766039fd2b8acbce241483f",
    qualified:
      metadataProofs.every(
        (proof) =>
          proof?.qualified === true &&
          proof.sdkSourceCommit === "f2690a3c9cfd0cf61bfb7ca31b802d249105d751" &&
          proof.archiveSHA256 ===
            "34562d43668a1ca09e95666da3237206b3744d0d0766039fd2b8acbce241483f" &&
          proof.oldV1Contract &&
          proof.v2MethodAbsent &&
          proof.currentV2Read &&
          proof.oldV1Read &&
          proof.nativeFactsPreserved &&
          proof.identityPreserved &&
          proof.noV2Probe &&
          /^[a-f0-9]{64}$/.test(proof.bundleSHA256) &&
          /^[a-f0-9]{64}$/.test(proof.oldSourceGraphSHA256) &&
          /^[a-f0-9]{64}$/.test(proof.dependencySHA256),
      ) &&
      baseline[0].receipt?.accountInfoCompatibility?.factualProvenance === true &&
      new Set(metadataProofs.map((proof) => proof?.bundleSHA256)).size === 1 &&
      new Set(metadataProofs.map((proof) => proof?.oldSourceGraphSHA256)).size === 1 &&
      new Set(metadataProofs.map((proof) => proof?.dependencySHA256)).size === 1,
    cases: metadataProofs,
  };
  const qualified =
    baselineQualified &&
    extensionQualified &&
    nativeSourcePostconditionsVerified &&
    gatewayCompatibility.qualified &&
    accountInfoCompatibility.qualified;
  qualification = {
    contract: "native-connections-joined-qualification/v1",
    qualified,
    nativeCommit: options.nativeCommit,
    gatewayCommit: options.gatewayCommit,
    rrCommit: options.rrCommit,
    sdkSHA256: options.sdkSHA256,
    ...sources,
    expectedInventoryRows: 53,
    expectedExtensionRows: 1,
    timeBudget,
    baselineQualified,
    nativeSourcePostconditionsVerified,
    consumerBuildDigest: identity,
    unchangedConsumerBuild,
    gatewayCompatibility,
    accountInfoCompatibility,
    extension: {
      contract: "native-provider-extension-qualification/v1",
      qualified: extensionQualified,
      rows: extension?.receipt?.rows ?? [],
      absentFromBaseline,
      unchangedConsumerBuild,
      enrolled: extension?.receipt?.enrolled ?? 0,
      reviewPassed: extension?.receipt?.reviewPassed ?? 0,
      exitCode: extension?.exitCode ?? 1,
    },
    enrolled: rows.filter((row) => row.enrolled).length,
    passed: rows.filter((row) => row.outcome === "passed").length,
    blocked: rows.filter((row) => row.outcome === "blocked").length,
    batches: batches.map(({ batch, exitCode, receipt, sourcePostconditionsVerified }) => ({
      batch,
      exitCode,
      sourcePostconditionsVerified,
      qualified: receipt?.qualified ?? false,
      passed: receipt?.passed ?? 0,
      failed: receipt?.failed ?? 0,
      blocked: receipt?.blocked ?? 0,
      enrolled: receipt?.enrolled ?? 0,
      reviewPassed: receipt?.reviewPassed ?? 0,
    })),
  };
  if (!qualified) {
    process.exitCode = 1;
  }
}
try {
  await main();
} catch (error) {
  report({ phase: "failed", at: phase, error: error instanceof Error ? error.name : "failure" });
  if (qualification) {
    qualification.failure = { at: phase, code: error instanceof Error ? error.name : "failure" };
  }
  process.exitCode = 1;
} finally {
  let postgresStopped = !pgState.startAttempted;
  try {
    if (
      pgData !== undefined &&
      pgBin !== undefined &&
      output !== undefined &&
      owned !== undefined &&
      pgState.startAttempted
    ) {
      // pg_ctl can time out after spawning the server. A failed start still
      // owns that cluster and must establish that it stopped before deletion.
      const status = pgState.started
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
        if (!postgresStopped) {
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
      }
      await copyFile(join(pgData, "postgres.log"), join(output, "postgres.log")).catch(() => {});
    }
  } catch {
    postgresStopped = false;
  }
  if (!postgresStopped) {
    process.exitCode = 1;
  }
  // Private cluster data, compiled binaries and CLI workspaces live in the
  // owned /tmp directory, outside the allowlisted CI evidence directory.
  if (owned !== undefined && postgresStopped) {
    await rm(owned, { recursive: true, force: true });
  }
  if (qualification && output !== undefined) {
    qualification.postgresStopped = postgresStopped;
    qualification.qualified = qualification.qualified === true && postgresStopped;
    qualification.exitCode = process.exitCode ?? 0;
    await writeFile(join(output, "run.json"), JSON.stringify(qualification, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    report({
      phase:
        qualification.failure !== undefined
          ? "failed"
          : qualification.qualified === true
            ? "completed"
            : "blocked",
      ...qualification,
    });
  }
}
