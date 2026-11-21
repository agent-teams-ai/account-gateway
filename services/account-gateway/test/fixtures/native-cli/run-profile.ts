// Host-side lifecycle for one isolated container and three uniquely named LSM
// profiles. Never replace docker-default or any host/system security setting.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  anonymousVolumeNames,
  ContainerInspectionError,
  array,
  object,
  bwrapSHA256,
  capabilities,
  codexSHA256,
  createAppArmor,
  createSeccomp,
  digest,
  esbuildRelativePath,
  esbuildSHA256,
  fileDigest,
  requireContainer,
  safePath,
  type BindMount,
} from "./execution-profile.ts";

let commandFailure:
  | {
      command: string;
      exitCode: number | null;
      signal: string | null;
      error: string | null;
    }
  | undefined;
let inspectionFailure: ContainerInspectionError["field"] | undefined;
function run(binary: string, args: string[], timeout = 30000, label = binary) {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    commandFailure ??= {
      command: label === "sudo" ? "sudo-" + args[0] : label,
      exitCode: result.status,
      signal: result.signal,
      error: result.error ? "spawn-or-timeout" : null,
    };
  }
  assert.equal(result.error, undefined, "profile-command-start");
  assert.equal(result.status, 0, "profile-command-exit");
  return result.stdout.trim();
}
function env(name: string) {
  const value = process.env[name];
  assert.ok(typeof value === "string" && value.length > 0);
  return safePath(value);
}

let loaded = false,
  created = false,
  loadAttempted = false,
  createAttempted = false;
const name = "gateway-joined-" + randomBytes(12).toString("hex");
const root = env("GATEWAY_CLIENT_ROOT"),
  repo = env("GITHUB_WORKSPACE");
const nodeHome = env("GATEWAY_CLIENT_NODE_HOME"),
  goHome = env("GATEWAY_CLIENT_GO_HOME");
const node = env("GATEWAY_CLIENT_NODE"),
  go = env("GATEWAY_CLIENT_GO");
const profilePath = join(root, "build/execution.apparmor"),
  seccompPath = join(root, "build/execution-seccomp.json");
const binaryPolicy = join(root, "build/execution.apparmor.bin"),
  configPath = join(root, "build/execution-config.json");
const hostReceipt = join(root, "artifacts/execution-host.json");
const parserRoot = join(root, "apparmor-tools");
const parserPins = object(
  JSON.parse(readFileSync(new URL("./apparmor-pins.json", import.meta.url), "utf8")) as unknown,
);
function parserInvocation(args: string[], privileged = false) {
  const loader = "/lib64/ld-linux-x86-64.so.2";
  const invocation = [
    "--library-path",
    join(parserRoot, "usr/lib/x86_64-linux-gnu"),
    join(parserRoot, "usr/sbin/apparmor_parser"),
    "--config-file",
    join(parserRoot, "empty.conf"),
    "--Include",
    join(parserRoot, "etc/apparmor.d"),
    ...args,
  ];
  return privileged
    ? { binary: "sudo", args: [loader, ...invocation] }
    : { binary: loader, args: invocation };
}
function parser(args: string[], privileged = false) {
  const invocation = parserInvocation(args, privileged);
  return run(invocation.binary, invocation.args, 30000, "apparmor_parser");
}
let outcome = "fail",
  stage = "prepare",
  anonymousVolumes: string[] = [];
let image = "",
  profileSHA256 = "",
  seccompSHA256 = "";
let esbuildVerified = false;
let kernelCompressedLoad: "yes" | "no" | "absent" | "other" | "unobserved" = "unobserved";
let compiledPolicy: {
  encoding: "uncompressed" | "unexpected";
  bytes: number;
  sha256: string;
} | null = null;
let containerRemoved = false,
  policyRemoved = false,
  volumesRemoved = false;
function ownedProfiles(): string[] {
  const names = new Set([name, name + "-bwrap", name + "-payload"]);
  return run("sudo", ["cat", "/sys/kernel/security/apparmor/profiles"])
    .split("\n")
    .map((line) => line.replace(/ \((?:enforce|complain|kill|unconfined)\)$/, ""))
    .filter((profile) => names.has(profile));
}
try {
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "x64");
  assert.equal(parserPins.version, "5.0.2");
  for (const [relative, sha256] of Object.entries(object(parserPins.files))) {
    assert.ok(!relative.startsWith("/") && !relative.includes(".."));
    assert.equal(fileDigest(safePath(join(parserRoot, relative))), sha256);
  }
  assert.match(parser(["--version"]), /version 5\.0\.2(?:\n|$)/);
  assert.match(
    readFileSync("/sys/kernel/security/apparmor/features/namespaces/mask", "utf8"),
    /\buserns_create\b/,
  );
  assert.equal(
    readFileSync("/sys/kernel/security/apparmor/features/domain/stack", "utf8").trim(),
    "yes",
  );
  const compressedFeature = "/sys/kernel/security/apparmor/features/policy/compressed_load";
  if (existsSync(compressedFeature)) {
    const value = readFileSync(compressedFeature, "utf8").trim();
    kernelCompressedLoad = value === "yes" || value === "no" ? value : "other";
  } else {
    kernelCompressedLoad = "absent";
  }
  assert.equal(fileDigest(join(root, "review-router-assets/codex-runtime/bin/codex")), codexSHA256);
  assert.equal(
    fileDigest(join(root, "review-router-assets/codex-runtime/codex-resources/bwrap")),
    bwrapSHA256,
  );
  const tsxPackage = join(root, "review-router-source/node_modules/tsx/package.json");
  assert.equal(object(JSON.parse(readFileSync(tsxPackage, "utf8")) as unknown).version, "4.23.1");
  const tsxRequire = createRequire(realpathSync(tsxPackage));
  const compilerRequire = createRequire(tsxRequire.resolve("esbuild"));
  const compiler = compilerRequire.resolve("@esbuild/linux-x64/bin/esbuild");
  assert.equal(realpathSync(compiler), join(root, esbuildRelativePath));
  assert.equal(fileDigest(compiler), esbuildSHA256);
  assert.equal(run(compiler, ["--version"], 30000, "esbuild"), "0.28.1");
  esbuildVerified = true;
  const profile = createAppArmor(name, { root, nodeHome, goHome });
  const seccomp = JSON.stringify(createSeccomp(), null, 2) + "\n";
  writeFileSync(profilePath, profile, { mode: 0o600, flag: "wx" });
  writeFileSync(seccompPath, seccomp, { mode: 0o600, flag: "wx" });
  profileSHA256 = digest(profile);
  seccompSHA256 = digest(seccomp);
  writeFileSync(join(root, "build/execution-canary"), "gateway-profile-read-control\n", {
    mode: 0o644,
    flag: "wx",
  });
  const gatewayCommit = run("git", ["rev-parse", "HEAD"]);
  const nativeCommit = process.env.NATIVE_COMMIT,
    reviewRouterCommit = process.env.REVIEW_ROUTER_COMMIT;
  assert.match(process.env.REVIEW_ACTION_COMMIT ?? "", /^[a-f0-9]{40}$/);
  assert.match(gatewayCommit, /^[a-f0-9]{40}$/);
  assert.match(nativeCommit ?? "", /^[a-f0-9]{40}$/);
  assert.match(reviewRouterCommit ?? "", /^[a-f0-9]{40}$/);
  const joinedArguments = [
    join(repo, "services/account-gateway/test/fixtures/native-cli/joined.ts"),
    "--repo",
    repo,
    "--pg-bin",
    "/usr/lib/postgresql/17/bin",
    "--go",
    go,
    "--claude-binary",
    "/tmp/native-claude-joined/fixture",
    "--codex-binary",
    "/tmp/native-device-joined/fixture",
    "--provider-binary",
    "/tmp/native-provider-joined/fixture",
    "--provider-preload",
    join(root, "review-router-assets/preload.mjs"),
    "--clients",
    join(root, "clients/clients.json"),
    "--build-receipt",
    join(root, "build/joined/joined-build.json"),
    "--artifacts",
    join(root, "artifacts/joined-clients"),
    "--native-commit",
    nativeCommit!,
    "--gateway-commit",
    gatewayCommit,
  ];
  // The complete native-method matrix uses the primary qualified runtime and
  // the same isolated container after the existing client gates. The Node 24
  // lane retains its original compatibility qualification.
  let connectionArguments: string[] | undefined;
  if (process.versions.node === "26.11.1") {
    const vendor = join(root, "review-router-source/vendor/account-gateway");
    const provenance = object(
      JSON.parse(
        readFileSync(join(vendor, "native-provider-parity-sdk-provenance.json"), "utf8"),
      ) as unknown,
    );
    assert.equal(provenance.contract, "native-provider-parity-sdk-provenance/v1");
    assert.equal(typeof provenance.archive, "string");
    assert.match(provenance.archive as string, /^agent-teams-account-gateway-[a-zA-Z0-9.-]+\.tgz$/);
    assert.equal(typeof provenance.sha256, "string");
    assert.match(provenance.sha256 as string, /^[a-f0-9]{64}$/);
    const sdkArchive = join(vendor, provenance.archive as string);
    assert.equal(fileDigest(sdkArchive), provenance.sha256);
    connectionArguments = [
      join(repo, "services/account-gateway/test/fixtures/native-connections-joined/run.ts"),
      "--gateway-root",
      repo,
      "--gateway-commit",
      gatewayCommit,
      "--native-root",
      join(root, "native-source"),
      "--native-commit",
      nativeCommit!,
      "--rr-root",
      join(root, "review-router-source"),
      "--rr-commit",
      reviewRouterCommit!,
      "--sdk-archive",
      sdkArchive,
      "--sdk-sha256",
      provenance.sha256 as string,
      "--pg-bin",
      "/usr/lib/postgresql/17/bin",
      "--go",
      go,
      "--output",
      join(root, "artifacts/native-connections"),
    ];
  }
  writeFileSync(
    configPath,
    JSON.stringify({
      name,
      root,
      gatewayCommit,
      nativeCommit,
      reviewRouterCommit,
      joinedArguments,
      ...(connectionArguments ? { connectionArguments } : {}),
      probeSHA256: fileDigest(join(root, "build/execution-probe")),
      profileSHA256,
      seccompSHA256,
    }) + "\n",
    { mode: 0o644, flag: "wx" },
  );
  stage = "compile";
  // Compile against the running kernel. Unsupported namespace mediation or any
  // compiler warning aborts; parser success alone is never runtime acceptance.
  parser([
    "--skip-kernel-load",
    "--skip-cache",
    "--Werror",
    "--zstd-compress-level=0",
    "--ofile",
    binaryPolicy,
    profilePath,
  ]);
  // Keep the complete profile set as raw records. Compressed --ofile output
  // adds a userspace header to each profile, which is not one load buffer.
  const binary = readFileSync(binaryPolicy);
  const versionRecord = Buffer.from("04080076657273696f6e0002", "hex");
  compiledPolicy = {
    encoding: binary.subarray(0, versionRecord.length).equals(versionRecord)
      ? "uncompressed"
      : "unexpected",
    bytes: binary.length,
    sha256: digest(binary),
  };
  assert.equal(compiledPolicy.encoding, "uncompressed");
  assert.ok(binary.length > versionRecord.length && binary.length <= 4 * 1024 * 1024);
  stage = "load";
  assert.deepEqual(ownedProfiles(), []);
  loadAttempted = true;
  parser(["--add", "--binary", "--zstd-compress-level=0", binaryPolicy], true);
  assert.deepEqual(
    ownedProfiles().toSorted(),
    [name, name + "-bwrap", name + "-payload"].toSorted(),
  );
  loaded = true;
  const mounts: BindMount[] = [
    { source: nodeHome, target: nodeHome, readonly: true },
    { source: goHome, target: goHome, readonly: true },
    { source: repo, target: repo, readonly: true },
    { source: root, target: root, readonly: true },
    ...["claude", "device", "provider"].map((part) => ({
      source: join(root, "build/joined/native-" + part + "-joined"),
      target: "/tmp/native-" + part + "-joined",
      readonly: true,
    })),
    {
      source: join(root, "artifacts"),
      target: join(root, "artifacts"),
      readonly: false,
    },
  ];
  image = run("docker", [
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    "gateway-native-clients:qualified",
  ]);
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const args = [
    "create",
    "--name",
    name,
    "--network",
    "none",
    "--user",
    "0:0",
    "--cpus",
    "2",
    "--memory",
    "4g",
    "--pids-limit",
    "256",
    "--ulimit",
    "nofile=4096:4096",
    "--cap-drop",
    "ALL",
    ...capabilities.flatMap((cap) => ["--cap-add", cap]),
    "--security-opt",
    "seccomp=" + seccompPath,
    "--security-opt",
    "apparmor=" + name,
  ];
  for (const mount of mounts) {
    args.push(
      "--mount",
      `type=bind,source=${mount.source},target=${mount.target}${mount.readonly ? ",readonly" : ""}`,
    );
  }
  for (const [key, value] of Object.entries({
    RR_PROVIDER_JOINED_SOURCE_COMMIT: reviewRouterCommit!,
    RR_PROVIDER_JOINED_ACTION_REF: process.env.REVIEW_ACTION_COMMIT!,
    RR_PROVIDER_JOINED_CODEX_VERSION: "0.133.0",
    RR_PROVIDER_JOINED_ACTION_ARCHIVE: join(root, "review-router-assets/action.tar"),
    RR_PROVIDER_JOINED_CODEX_BINARY: join(root, "review-router-assets/codex-runtime/bin/codex"),
    RR_PROVIDER_JOINED_RELAY_ADAPTER: join(
      root,
      "review-router-source/apps/api/src/review-run-gateway-relay.ts",
    ),
    // Host compilation has already downloaded and verified these exact module
    // checksums. Container execution has no network and cannot fetch a fallback.
    GOMODCACHE: join(root, "go-modules"),
    GOPROXY: "off",
    CGO_ENABLED: "0",
  })) {
    args.push("--env", key + "=" + value);
  }
  args.push(
    "--entrypoint",
    node,
    image,
    join(repo, "services/account-gateway/test/fixtures/native-cli/execution-preflight.ts"),
    configPath,
  );
  stage = "create";
  createAttempted = true;
  run("docker", args);
  created = true;
  const inspected = array(JSON.parse(run("docker", ["inspect", name])) as unknown);
  assert.equal(inspected.length, 1);
  stage = "inspect";
  anonymousVolumes = anonymousVolumeNames(inspected[0]);
  requireContainer(inspected[0], { name, image, seccomp: seccompPath, mounts });
  stage = "execute";
  process.stdout.write(
    run("docker", ["start", "--attach", name], connectionArguments ? 7_200_000 : 660_000) + "\n",
  );
  const ended = array(JSON.parse(run("docker", ["inspect", name])) as unknown);
  const state = object(object(ended[0]).State);
  assert.equal(state.Running, false);
  assert.equal(state.ExitCode, 0);
  assert.equal(state.OOMKilled, false);
  outcome = "pass";
} catch (error) {
  if (error instanceof ContainerInspectionError) {
    inspectionFailure = error.field;
  }
  process.stderr.write("gateway-joined-execution-profile-failed-" + stage + "\n");
  process.exitCode = 1;
} finally {
  if (createAttempted) {
    try {
      const exists = run("docker", ["container", "ls", "--all", "--format", "{{.Names}}"])
        .split("\n")
        .includes(name);
      if (exists) {
        created = true;
        // A failed create response may still have created the owned container.
        anonymousVolumes = anonymousVolumeNames(
          array(JSON.parse(run("docker", ["inspect", name])) as unknown)[0],
        );
        run("docker", ["rm", "--force", "--volumes", name]);
      }
      containerRemoved = !run("docker", ["container", "ls", "--all", "--format", "{{.Names}}"])
        .split("\n")
        .includes(name);
      const volumes = run("docker", ["volume", "ls", "--format", "{{.Name}}"]).split("\n");
      volumesRemoved = anonymousVolumes.every((volume) => !volumes.includes(volume));
    } catch {}
  }
  if (loadAttempted && (!createAttempted || containerRemoved)) {
    try {
      if (ownedProfiles().length > 0) {
        // Multi-profile load can fail after a subset was installed. Removal may
        // then report missing profiles; actual kernel names decide cleanup.
        const invocation = parserInvocation(["--remove", profilePath], true);
        spawnSync(invocation.binary, invocation.args, {
          encoding: "utf8",
          timeout: 30000,
        });
      }
      policyRemoved = ownedProfiles().length === 0;
    } catch {}
  }
  const cleanup =
    (!createAttempted || (containerRemoved && volumesRemoved)) && (!loadAttempted || policyRemoved);
  if (!cleanup) {
    outcome = "fail";
    process.exitCode = 1;
  }
  if (existsSync(join(root, "artifacts"))) {
    const receipt =
      JSON.stringify(
        {
          kind: "gateway-execution-host/v1",
          outcome,
          stage,
          image,
          profileSHA256,
          seccompSHA256,
          parserPinsSHA256: digest(readFileSync(new URL("./apparmor-pins.json", import.meta.url))),
          esbuild: {
            version: "0.28.1",
            sha256: esbuildSHA256,
            verified: esbuildVerified,
          },
          kernelCompressedLoad,
          compiledPolicy,
          loaded,
          created,
          containerRemoved,
          volumesRemoved,
          policyRemoved,
          cleanup,
          ...(commandFailure ? { failure: commandFailure } : {}),
          ...(inspectionFailure ? { inspectionFailure } : {}),
        },
        null,
        2,
      ) + "\n";
    // The original workflow deliberately owns this artifact directory as root.
    const written = spawnSync("sudo", ["tee", hostReceipt], {
      input: receipt,
      encoding: "utf8",
    });
    if (written.status !== 0) {
      process.exitCode = 1;
    }
  }
}
