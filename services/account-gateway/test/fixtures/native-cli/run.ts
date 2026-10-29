// Run only inside a disposable Linux container/private network namespace.
// Real client processes, Go public handlers, native OAuth/identity SQL and TLS
// fixtures are qualified. Metadata authority is a fixture; this is not a test
// of the full TS kernel composition or live upstream provider acceptance.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isNonemptyString } from "./joined-evidence.ts";
import type { ClientPins, InstalledClients } from "./joined-evidence.ts";
import { clientTests, goTestEvidence, repositoryTests as repositoryTestNames } from "./evidence.ts";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function check(condition: unknown, code: string): asserts condition {
  const accepted = Boolean(condition);
  if (!accepted) {
    throw new Error(code);
  }
}
class CommandFailure extends Error {
  readonly output: string;
  constructor(output: string) {
    super("bounded-command-failed");
    this.output = output;
  }
}
async function command(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  options: { uid?: number; timeout?: number; expected?: number } = {},
) {
  const child = spawn(binary, args, {
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
  const capture = (chunk: Buffer) => {
    size += chunk.length;
    if (size > 4_194_304) {
      overflow = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
    } else {
      output += chunk.toString("utf8");
    }
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const timer = setTimeout(() => {
    expired = true;
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {}
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
async function port() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  check(address !== null && typeof address !== "string", "local-port");
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
    "qualified-runtime-required",
  );
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    check(/^--[a-z-]+$/.test(process.argv[i]) && !!process.argv[i + 1], "arguments");
    args.set(process.argv[i], process.argv[i + 1]);
  }
  const pgBin = args.get("--pg-bin"),
    binary = args.get("--test-binary"),
    clientsFile = args.get("--clients"),
    artifacts = args.get("--artifacts");
  const repositoryTests = args.get("--repository-test-binary");
  check(
    isNonemptyString(pgBin) &&
      isNonemptyString(binary) &&
      isNonemptyString(clientsFile) &&
      isNonemptyString(artifacts) &&
      [pgBin, binary, clientsFile, artifacts].every(isAbsolute),
    "absolute-inputs-required",
  );
  check(
    repositoryTests === undefined || isAbsolute(repositoryTests),
    "absolute-repository-test-binary",
  );
  check(!existsSync(artifacts), "fresh-artifact-directory-required");
  mkdirSync(artifacts, { recursive: true, mode: 0o700 });
  const links = readFileSync("/proc/net/dev", "utf8")
    .trim()
    .split("\n")
    .slice(2)
    .map((line) => line.split(":")[0].trim());
  const routes = readFileSync("/proc/net/route", "utf8").trim().split("\n").slice(1);
  check(
    links.length === 1 && links[0] === "lo" && routes.length === 0,
    "external-network-must-be-disabled",
  );
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host: "192.0.2.1", port: 443 });
    socket.setTimeout(500, () => {
      socket.destroy();
      reject(new Error("external-probe-timeout"));
    });
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error("external-network-available"));
    });
    socket.once("error", (error) => {
      socket.destroy();
      if ("code" in error && error.code === "ENETUNREACH") {
        resolve();
      } else {
        reject(new Error("external-probe-failed"));
      }
    });
  });
  const network = {
    interfaces: "lo only",
    ipv4Routes: "none",
    negativeExternalOrigin: "192.0.2.1:443 ENETUNREACH",
    networkNamespace: readlinkSync("/proc/self/ns/net"),
  };
  const evidence = join(artifacts, "network.json");
  writeFileSync(evidence, JSON.stringify(network), { mode: 0o600 });
  const pinnedBytes = readFileSync(fileURLToPath(new URL("./pins.json", import.meta.url))),
    pins = JSON.parse(pinnedBytes.toString()) as ClientPins;
  const clients = JSON.parse(readFileSync(clientsFile, "utf8")) as InstalledClients;
  check(
    clients.pinsSHA256 === sha256(pinnedBytes) && clients.clients.length === 2,
    "client-receipt-pins",
  );
  const env: NodeJS.ProcessEnv = {
    PATH: pgBin + ":/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    PGSSLMODE: "disable",
    PGPASSFILE: "/dev/null",
    AG_LOAD_NETWORK_EVIDENCE: evidence,
  };
  for (const expected of pins.clients) {
    const installed = clients.clients.find((client: { id: string }) => client.id === expected.id);
    check(
      installed &&
        isAbsolute(installed.executable) &&
        sha256(readFileSync(installed.executable)) === expected.binarySHA256,
      "client-binary-pin",
    );
    env[`GATEWAY_NATIVE_CLIENT_${expected.id.toUpperCase()}_BINARY`] = installed.executable;
  }
  const owned = mkdtempSync(join(tmpdir(), "gateway-native-clients-"));
  chmodSync(owned, 0o755);
  const data = join(owned, "pg");
  mkdirSync(data, { mode: 0o700 });
  chownSync(data, 65534, 65534);
  let started = false,
    success = false,
    stopped = false,
    testLog = "",
    repositoryLog = "";
  try {
    await command(
      join(pgBin, "initdb"),
      ["-D", data, "--username=postgres", "--auth=trust", "--no-locale", "--encoding=UTF8"],
      env,
      { uid: 65534 },
    );
    const pgPort = await port();
    const config = join(data, "postgresql.conf");
    writeFileSync(
      config,
      readFileSync(config, "utf8") +
        `\nlisten_addresses='127.0.0.1'\nport=${pgPort}\nunix_socket_directories='${data}'\nmax_connections=30\nshared_buffers='32MB'\n`,
    );
    await command(
      join(pgBin, "pg_ctl"),
      ["-D", data, "-l", join(data, "postgres.log"), "-w", "start"],
      env,
      { uid: 65534 },
    );
    started = true;
    for (const client of ["CLAUDE", "CODEX"]) {
      const name = "gateway_cli_test_" + randomUUID().replaceAll("-", "");
      await command(
        join(pgBin, "createdb"),
        ["-h", "127.0.0.1", "-p", String(pgPort), "-U", "postgres", name],
        env,
      );
      env[`GATEWAY_NATIVE_CLIENT_${client}_DSN`] =
        `postgresql://postgres@127.0.0.1:${pgPort}/${name}?sslmode=disable`;
    }
    if (isNonemptyString(repositoryTests)) {
      for (const [variable, prefix] of [
        ["GATEWAY_NATIVE_CLAUDE_TEST_DSN", "gateway_claude_test_"],
        ["GATEWAY_NATIVE_CLAUDE_STREAM_TEST_DSN", "gateway_claude_stream_test_"],
      ]) {
        const name = prefix + randomUUID().replaceAll("-", "");
        await command(
          join(pgBin, "createdb"),
          ["-h", "127.0.0.1", "-p", String(pgPort), "-U", "postgres", name],
          env,
        );
        env[variable] = `postgresql://postgres@127.0.0.1:${pgPort}/${name}?sslmode=disable`;
      }
      try {
        repositoryLog = await command(
          repositoryTests,
          ["-test.v", "-test.run", "^TestGatewayNativeClaudePostgres", "-test.timeout", "90s"],
          env,
          { timeout: 110_000 },
        );
      } catch (error) {
        if (error instanceof CommandFailure) {
          repositoryLog = error.output;
        }
        throw error;
      }
      check(
        !repositoryLog.includes("SKIP") &&
          repositoryLog.includes(
            "--- PASS: TestGatewayNativeClaudePostgresLifecycleAndPassiveLimits",
          ) &&
          repositoryLog.includes(
            "--- PASS: TestGatewayNativeClaudePostgresStreamsReleaseSQLAtHeaders",
          ),
        "both-claude-postgres-tests-required",
      );
    }
    try {
      testLog = await command(
        binary,
        [
          "-test.v",
          "-test.run",
          "^TestPinned(ClaudeCodeCLIThroughPublicMessages|CodexCLIThroughPublicResponses)Postgres$",
          "-test.timeout",
          "90s",
        ],
        env,
        { timeout: 110_000 },
      );
    } catch (error) {
      if (error instanceof CommandFailure) {
        testLog = error.output;
      }
      throw error;
    }
    check(
      !testLog.includes("SKIP") &&
        !testLog.includes("no tests to run") &&
        testLog.includes("--- PASS: TestPinnedClaudeCodeCLIThroughPublicMessagesPostgres") &&
        testLog.includes("--- PASS: TestPinnedCodexCLIThroughPublicResponsesPostgres"),
      "both-process-tests-required",
    );
    success = true;
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
    writeFileSync(
      join(artifacts, "test.log"),
      JSON.stringify(goTestEvidence(testLog, clientTests), null, 2) + "\n",
      { mode: 0o600 },
    );
    if (isNonemptyString(repositoryTests)) {
      writeFileSync(
        join(artifacts, "repository-test.log"),
        JSON.stringify(goTestEvidence(repositoryLog, repositoryTestNames), null, 2) + "\n",
        { mode: 0o600 },
      );
    }
    const result = {
      kind: "gateway-native-client-qualification/v1",
      outcome: success && stopped ? "pass" : "fail",
      node: process.version,
      nativeCommit: args.get("--native-commit"),
      gatewayCommit: args.get("--gateway-commit"),
      testBinarySHA256: sha256(readFileSync(binary)),
      repositoryTestBinarySHA256: isNonemptyString(repositoryTests)
        ? sha256(readFileSync(repositoryTests))
        : undefined,
      pinsSHA256: sha256(pinnedBytes),
      clients: pins.clients.map(
        (client: { id: string; version: string; binarySHA256: string }) => ({
          id: client.id,
          version: client.version,
          binarySHA256: client.binarySHA256,
        }),
      ),
      network,
      postgresStopped: stopped,
      authorityScope:
        "metadata fixture; native OAuth identity and terminal usage in real PostgreSQL",
      providerScope: "controlled loopback TLS; no live provider",
    };
    writeFileSync(join(artifacts, "result.json"), JSON.stringify(result, null, 2) + "\n", {
      mode: 0o600,
    });
    check(success && stopped, "client-qualification-failed");
    process.stdout.write(JSON.stringify(result) + "\n");
  }
}
main().catch((error: unknown) => {
  process.stderr.write(
    JSON.stringify({
      outcome: "fail",
      code: error instanceof Error ? error.message : "operator-failed",
    }) + "\n",
  );
  process.exitCode = 1;
});
