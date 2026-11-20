// Runs inside the exact joined container, before PostgreSQL or any provider flow.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { command, CommandFailure } from "./joined-command.ts";
import { payloadCommandFailure } from "./execution-diagnostics.ts";
import {
  fileDigest,
  codexSHA256,
  bwrapSHA256,
  safePath,
  safeProfileName,
  object,
} from "./execution-profile.ts";

interface PreflightConfig {
  readonly name: string;
  readonly root: string;
  readonly joinedArguments: string[];
  readonly gatewayCommit: string;
  readonly nativeCommit: string;
  readonly reviewRouterCommit: string;
  readonly probeSHA256: string;
  readonly profileSHA256: string;
  readonly seccompSHA256: string;
}
interface ProbeReceipt {
  readonly kind: string;
  readonly phase: string;
  readonly uid: number;
  readonly profile: string;
  readonly checks: Record<string, boolean>;
  readonly pass: boolean;
}
type ProbeReportField = "empty" | "size" | "json" | "identity" | "profile" | "pass" | "checks";
export class ProbeReportError extends Error {
  readonly field: ProbeReportField;
  constructor(field: ProbeReportField) {
    super("execution-probe-report:" + field);
    this.field = field;
  }
}
function parseProbe(
  raw: string,
  expected: { phase: string; uid: number; profile: string },
): ProbeReceipt {
  let field: ProbeReportField = "empty";
  try {
    assert.ok(raw.trim().length > 0);
    field = "size";
    assert.ok(Buffer.byteLength(raw) <= 8192);
    field = "json";
    const result = object(JSON.parse(raw) as unknown);
    field = "identity";
    assert.equal(result.kind, "gateway-execution-probe/v1");
    assert.equal(result.phase, expected.phase);
    assert.equal(result.uid, expected.uid);
    field = "profile";
    assert.equal(result.profile, expected.profile + " (enforce)");
    field = "pass";
    assert.equal(typeof result.pass, "boolean");
    const keys = [
      "enforcedProfile",
      "seccompFilter",
      "noInitialSysAdmin",
      "canaryRead",
      "userNamespaceDenied",
      "mountDenied",
      "immutableWriteDenied",
      "immutableModeDenied",
      "ownedChildAlive",
      "processMemoryReadDenied",
      "processMemoryWriteDenied",
      "procMemoryDenied",
      "ptraceDenied",
    ];
    if (expected.phase === "payload") {
      keys.push(
        "noNewPrivileges",
        "workspaceWriteDenied",
        "workspaceModeDenied",
        "outsideWriteDenied",
        "outsideModeDenied",
        "loopbackDenied",
      );
    }
    field = "checks";
    const checks = object(result.checks);
    assert.deepEqual(Object.keys(checks).toSorted(), keys.toSorted());
    assert.ok(keys.every((key) => typeof checks[key] === "boolean"));
    return {
      kind: "gateway-execution-probe/v1",
      phase: expected.phase,
      uid: expected.uid,
      profile: expected.profile + " (enforce)",
      pass: result.pass === true,
      checks: Object.fromEntries(keys.map((key) => [key, checks[key] === true])),
    };
  } catch {
    throw new ProbeReportError(field);
  }
}
export function requireProbe(
  raw: string,
  expected: { phase: string; uid: number; profile: string },
): ProbeReceipt {
  const result = parseProbe(raw, expected);
  assert.equal(result.pass, true);
  assert.ok(Object.values(result.checks).every((value) => value));
  return result;
}

async function main() {
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "x64");
  assert.equal(process.getuid?.(), 0);
  assert.equal(process.argv.length, 3);
  const config = JSON.parse(readFileSync(safePath(process.argv[2]), "utf8")) as PreflightConfig;
  const root = safePath(config.root),
    name = safeProfileName(config.name);
  const receiptPath = join(root, "artifacts/execution-preflight.json");
  const probe = join(root, "build/execution-probe");
  const cli = join(root, "review-router-assets/codex-runtime/bin/codex");
  const helper = join(root, "review-router-assets/codex-runtime/codex-resources/bwrap");
  assert.equal(fileDigest(probe), config.probeSHA256);
  assert.equal(fileDigest(cli), codexSHA256);
  assert.equal(fileDigest(helper), bwrapSHA256);
  const canary = join(root, "build/execution-canary");
  const scratch = mkdtempSync("/tmp/gateway-profile-");
  chmodSync(scratch, 0o755);
  const workspace = join(scratch, "workspace"),
    outside = join(scratch, "outside"),
    home = join(scratch, "home");
  for (const path of [workspace, outside, home]) {
    mkdirSync(path, { mode: 0o777 });
    chmodSync(path, 0o777);
  }
  for (const path of [workspace, outside]) {
    writeFileSync(join(path, "mutable-control"), "parent-write-control\n", { mode: 0o644 });
    chmodSync(join(path, "mutable-control"), 0o644);
  }
  const environment: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin",
    HOME: home,
    LANG: "C",
    LC_ALL: "C",
  };
  const receipts: ProbeReceipt[] = [];
  const runtimeAccess: Array<{
    target: "codex" | "bwrap";
    uid: 65534;
    readableExecutable: boolean;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
  }> = [];
  let probeFailure: { phase: string; uid: number; field: ProbeReportField } | undefined;
  let commandFailure: ReturnType<typeof payloadCommandFailure> | undefined;
  const capture = (raw: string, expected: { phase: string; uid: number; profile: string }) => {
    try {
      receipts.push(parseProbe(raw, expected));
    } catch (error) {
      if (error instanceof ProbeReportError) {
        probeFailure = { phase: expected.phase, uid: expected.uid, field: error.field };
      }
    }
  };
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.end();
  });
  let success = false;
  let stage = "outer";
  try {
    for (const uid of [0, 65534]) {
      const run = spawnSync(probe, ["outer", name, canary, workspace, outside, "0"], {
        encoding: "utf8",
        uid,
        gid: uid,
        env: environment,
        timeout: 15000,
        maxBuffer: 8192,
      });
      capture(run.stdout, { phase: "outer", uid, profile: name });
      assert.equal(run.status, 0);
      requireProbe(run.stdout, { phase: "outer", uid, profile: name });
    }
    stage = "runtime-access";
    for (const [target, path] of [
      ["codex", cli],
      ["bwrap", helper],
    ] as const) {
      const access = spawnSync("/usr/bin/test", ["-r", path, "-a", "-x", path], {
        uid: 65534,
        gid: 65534,
        env: environment,
        timeout: 15000,
        maxBuffer: 8192,
      });
      const readableExecutable =
        access.error === undefined && access.status === 0 && access.signal === null;
      runtimeAccess.push({
        target,
        uid: 65534,
        readableExecutable,
        exitCode: access.status,
        signal: access.signal,
        timedOut:
          access.error !== undefined && "code" in access.error && access.error.code === "ETIMEDOUT",
      });
      assert.equal(readableExecutable, true);
    }
    stage = "payload-control";
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port: address.port });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", reject);
      socket.setTimeout(1000, () => {
        socket.destroy();
        reject(new Error("execution-positive-control"));
      });
    });
    const profile = name + "-bwrap//&" + name + "-payload";
    stage = "payload-command";
    let stdout: string;
    try {
      stdout = await command(
        cli,
        [
          "sandbox",
          "linux",
          "-c",
          "features.use_legacy_landlock=false",
          "-c",
          'sandbox_mode="read-only"',
          "--",
          probe,
          "payload",
          profile,
          canary,
          workspace,
          outside,
          String(address.port),
        ],
        environment,
        { cwd: workspace, timeout: 15000 },
      );
    } catch (error) {
      commandFailure = payloadCommandFailure(error);
      if (error instanceof CommandFailure) {
        capture(error.stdout, { phase: "payload", uid: 0, profile });
      }
      throw error;
    }
    stage = "payload-proof";
    capture(stdout, { phase: "payload", uid: 0, profile });
    requireProbe(stdout, { phase: "payload", uid: 0, profile });
    stage = "payload-postconditions";
    for (const path of [workspace, outside]) {
      assert.equal(readFileSync(join(path, "mutable-control"), "utf8"), "parent-write-control\n");
      assert.equal(statSync(join(path, "mutable-control")).mode & 0o777, 0o644);
    }
    assert.equal(readFileSync(canary, "utf8"), "gateway-profile-read-control\n");
    assert.equal(fileDigest(cli), codexSHA256);
    assert.equal(fileDigest(helper), bwrapSHA256);
    success = true;
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
    writeFileSync(
      receiptPath,
      JSON.stringify(
        {
          kind: "gateway-execution-preflight/v1",
          outcome: success ? "pass" : "fail",
          stage,
          gatewayCommit: config.gatewayCommit,
          nativeCommit: config.nativeCommit,
          reviewRouterCommit: config.reviewRouterCommit,
          profileSHA256: config.profileSHA256,
          seccompSHA256: config.seccompSHA256,
          probeSHA256: config.probeSHA256,
          codexSHA256,
          bwrapSHA256,
          receipts,
          runtimeAccess,
          probeFailure,
          commandFailure,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
  }
  assert.ok(success);
  // This is the original joined runner and arguments. Its six provider receipts,
  // own CLI read/write/network/NNP proof and SQL closure gate remain mandatory.
  process.stdout.write(
    await command(process.execPath, config.joinedArguments, process.env, { timeout: 600000 }),
  );
}
if (process.argv[1]?.endsWith("/execution-preflight.ts")) {
  main().catch(() => {
    process.stderr.write("gateway-execution-preflight-failed\n");
    process.exitCode = 1;
  });
}
