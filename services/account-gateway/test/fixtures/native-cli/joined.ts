// Actual CLI -> TypeScript authority/usage -> Go OAuth -> controlled TLS/PG.
// Build/install happen before this disposable, explicitly egress-free process.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  digestFile,
  joinedFailure,
  joinedFiles,
  joinedReceipt,
  joinedSourceHashes,
} from "./joined-evidence.ts";
import type { ClientPins, InstalledClients, JoinedBuildReceipt } from "./joined-evidence.ts";

function check(value: unknown, code: string): asserts value {
  const accepted = Boolean(value);
  if (!accepted) {
    throw new Error(code);
  }
}
class CommandFailure extends Error {
  readonly output: string;
  constructor(output: string) {
    super("joined-command-failed");
    this.output = output;
  }
}
async function command(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  options: { uid?: number; timeout?: number; expected?: number; cwd?: string } = {},
) {
  const child = spawn(binary, args, {
    cwd: options.cwd,
    env,
    uid: options.uid,
    gid: options.uid,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let output = "",
    size = 0,
    overflow = false,
    expired = false;
  const kill = () => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {}
  };
  const capture = (bytes: Buffer) => {
    size += bytes.length;
    if (size > 4_194_304) {
      overflow = true;
      kill();
    } else {
      output += bytes.toString("utf8");
    }
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const timer = setTimeout(() => {
    expired = true;
    kill();
  }, options.timeout ?? 30_000);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }).finally(() => {
    clearTimeout(timer);
  });
  const commandFailed = () => expired || overflow;
  if (commandFailed() || code !== (options.expected ?? 0)) {
    throw new CommandFailure(output);
  }
  return output;
}
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  check(address !== null && typeof address !== "string", "joined-port");
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return address.port;
}
async function main() {
  check(
    process.platform === "linux" &&
      process.getuid?.() === 0 &&
      ["v26.11.1", "v24.21.0"].includes(process.version),
    "joined-runtime",
  );
  const options = new Map<string, string>();
  const keys = [
    "--repo",
    "--pg-bin",
    "--go",
    "--claude-binary",
    "--codex-binary",
    "--clients",
    "--build-receipt",
    "--artifacts",
    "--native-commit",
    "--gateway-commit",
  ];
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i],
      value = process.argv[i + 1];
    check(keys.includes(key) && value && !options.has(key), "joined-arguments");
    options.set(key, value);
  }
  check(
    keys.every((key) => options.has(key)),
    "joined-arguments",
  );
  const get = (key: string) => options.get(key)!;
  for (const key of keys.filter((candidate) => !candidate.endsWith("-commit"))) {
    check(isAbsolute(get(key)), "joined-absolute-path");
  }
  const repo = get("--repo"),
    pgBin = get("--pg-bin"),
    go = get("--go"),
    artifacts = get("--artifacts");
  const nativeCommit = get("--native-commit"),
    gatewayCommit = get("--gateway-commit");
  check(
    /^[a-f0-9]{40}$/.test(nativeCommit) && /^[a-f0-9]{40}$/.test(gatewayCommit),
    "joined-source-pins",
  );
  check(!existsSync(artifacts), "joined-fresh-artifacts");
  mkdirSync(artifacts, { recursive: true, mode: 0o700 });
  const interfaces = readFileSync("/proc/net/dev", "utf8")
    .trim()
    .split("\n")
    .slice(2)
    .map((line) => line.split(":")[0].trim());
  const routes = readFileSync("/proc/net/route", "utf8").trim().split("\n").slice(1);
  check(
    interfaces.length === 1 && interfaces[0] === "lo" && routes.length === 0,
    "joined-network-isolation",
  );
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host: "192.0.2.1", port: 443 });
    socket.setTimeout(500, () => {
      socket.destroy();
      reject(new Error("joined-network-probe"));
    });
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error("joined-network-probe"));
    });
    socket.once("error", (error) => {
      socket.destroy();
      if ("code" in error && error.code === "ENETUNREACH") {
        resolve();
      } else {
        reject(new Error("joined-network-probe"));
      }
    });
  });
  const network = {
    interfaces: "lo only",
    ipv4Routes: "none",
    negativeExternalOrigin: "192.0.2.1:443 ENETUNREACH",
    networkNamespace: readlinkSync("/proc/self/ns/net"),
  };
  const networkFile = join(artifacts, "network.json");
  writeFileSync(networkFile, JSON.stringify(network), { mode: 0o600 });
  const pinsPath = fileURLToPath(new URL("./pins.json", import.meta.url)),
    pins = JSON.parse(readFileSync(pinsPath, "utf8")) as ClientPins;
  const installed = JSON.parse(readFileSync(get("--clients"), "utf8")) as InstalledClients;
  check(
    installed.pinsSHA256 === digestFile(pinsPath) && installed.clients.length === 2,
    "joined-client-receipt",
  );
  const build = JSON.parse(readFileSync(get("--build-receipt"), "utf8")) as JoinedBuildReceipt,
    sourceHashes = joinedSourceHashes(repo);
  check(
    build.kind === "gateway-joined-client-build/v1" &&
      build.nativeCommit === nativeCommit &&
      build.gatewayCommit === gatewayCommit &&
      build.goVersion === "go1.27.3" &&
      JSON.stringify(build.sourceHashes) === JSON.stringify(sourceHashes),
    "joined-build-receipt",
  );
  const binaries = build.binaries;
  check(binaries !== null && binaries !== undefined, "joined-build-receipt");
  const clients = (["claude", "codex"] as const).map((id) => {
    const pin = pins.clients.find((p: { id: string }) => p.id === id),
      client = installed.clients.find((p: { id: string }) => p.id === id);
    const binary = get("--" + id + "-binary");
    check(
      pin &&
        client &&
        isAbsolute(client.executable) &&
        digestFile(client.executable) === pin.binarySHA256 &&
        digestFile(binary) === binaries[id],
      "joined-binary-pin",
    );
    return { id, pin, executable: client.executable, binary };
  });
  const owned = mkdtempSync(join(tmpdir(), "gateway-joined-clients-"));
  chmodSync(owned, 0o755);
  const data = join(owned, "pg");
  mkdirSync(data, { mode: 0o700 });
  chownSync(data, 65534, 65534);
  const env: NodeJS.ProcessEnv = {
    PATH: pgBin + ":" + dirname(go) + ":/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    PGSSLMODE: "disable",
    PGPASSFILE: "/dev/null",
    GOTOOLCHAIN: "local",
    AG_LOAD_NETWORK_EVIDENCE: networkFile,
  };
  let started = false,
    stopped = false,
    success = false;
  let failure: { code: string; at?: string; frame?: string } | undefined;
  const receipts: ReturnType<typeof joinedReceipt>[] = [];
  try {
    await command(
      join(pgBin, "initdb"),
      ["-D", data, "--username=postgres", "--auth=trust", "--no-locale", "--encoding=UTF8"],
      env,
      { uid: 65534 },
    );
    const port = await freePort(),
      config = join(data, "postgresql.conf");
    writeFileSync(
      config,
      readFileSync(config, "utf8") +
        `\nlisten_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories='${data}'\nmax_connections=40\nshared_buffers='32MB'\n`,
    );
    await command(
      join(pgBin, "pg_ctl"),
      ["-D", data, "-l", join(data, "postgres.log"), "-w", "start"],
      env,
      { uid: 65534 },
    );
    started = true;
    for (const client of clients) {
      const fixture = client.id === "claude" ? "CLAUDE" : "DEVICE",
        label = fixture.toLowerCase();
      const childEnv = { ...env },
        prefix = "AG_NATIVE_" + fixture + "_JOINED_";
      for (const [key, dbPrefix] of [
        ["NATIVE_DSN", "native_" + label + "_joined_"],
        ["KERNEL_DSN", "ag_kernel_test_" + label + "_joined_"],
      ]) {
        const name = dbPrefix + randomUUID().replaceAll("-", "");
        await command(
          join(pgBin, "createdb"),
          ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", name],
          env,
        );
        childEnv[prefix + key] = `postgresql://postgres@127.0.0.1:${port}/${name}?sslmode=disable`;
      }
      const scratch = join(owned, client.id);
      mkdirSync(scratch, { mode: 0o700 });
      Object.assign(childEnv, {
        [prefix + "ALLOW"]: "disposable_pg17_10",
        [prefix + "BINARY"]: client.binary,
        [prefix + "CLI_BINARY"]: client.executable,
        [prefix + "NATIVE_COMMIT"]: nativeCommit,
        [prefix + "GATEWAY_COMMIT"]: gatewayCommit,
        [prefix + "GO"]: go,
        [prefix + "SCRATCH_ROOT"]: scratch,
      });
      const output = await command(
        process.execPath,
        [join(repo, joinedFiles[(client.id + "Harness") as "claudeHarness" | "codexHarness"])],
        childEnv,
        { cwd: repo, timeout: 120_000 },
      );
      receipts.push(
        joinedReceipt(output, client.id, {
          nativeCommit,
          gatewayCommit,
          binarySHA256: binaries[client.id],
          version: client.pin.version.replace(/-linux-x64$/, ""),
          clientSHA256: client.pin.binarySHA256,
          sourceHashes,
        }),
      );
    }
    check(
      JSON.stringify(joinedSourceHashes(repo)) === JSON.stringify(sourceHashes),
      "joined-runtime-source-changed",
    );
    success = receipts.length === 2;
  } catch (error) {
    failure =
      error instanceof CommandFailure
        ? joinedFailure(error.output)
        : {
            code:
              error instanceof Error && /^joined-[a-z-]+$/.test(error.message)
                ? error.message
                : "joined-qualification-failed",
          };
  } finally {
    if (started) {
      try {
        await command(join(pgBin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"], env, {
          uid: 65534,
        });
        await command(join(pgBin, "pg_ctl"), ["-D", data, "status"], env, {
          uid: 65534,
          expected: 3,
        });
        stopped = true;
      } catch {
        stopped = false;
      }
    }
    const result = {
      kind: "gateway-joined-client-qualification/v1",
      outcome: success && stopped ? "pass" : "fail",
      node: process.version,
      nativeCommit,
      gatewayCommit,
      sourceHashes,
      pinsSHA256: digestFile(pinsPath),
      network,
      postgresStopped: stopped,
      authorityScope:
        "real TypeScript execution capability, admission, usage, ACK and cleanup; real Go OAuth and PostgreSQL",
      providerScope: "controlled loopback TLS; no live provider",
      clients: receipts,
      ...(failure ? { failure } : {}),
    };
    const safe = JSON.stringify(result, null, 2) + "\n";
    writeFileSync(join(artifacts, "result.json"), safe, { mode: 0o600 });
    process.stdout.write(safe);
    check(success && stopped, "joined-qualification-failed");
  }
}
main().catch((error: unknown) => {
  process.stderr.write(
    JSON.stringify({
      outcome: "fail",
      code:
        error instanceof Error && /^joined-[a-z-]+$/.test(error.message)
          ? error.message
          : "joined-operator-failed",
    }) + "\n",
  );
  process.exitCode = 1;
});
