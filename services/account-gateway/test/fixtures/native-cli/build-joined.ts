// Build the two disposable joined fixtures against one clean pinned Go tree.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { digestFile, joinedFiles, joinedSourceHashes } from "./joined-evidence.ts";

function check(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
function command(binary: string, args: string[], cwd: string) {
  const child = spawnSync(binary, args, {
    cwd,
    env: { ...process.env, CGO_ENABLED: "0", GOTOOLCHAIN: "local" },
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 4_194_304,
  });
  check(child.status === 0 && !child.error, "joined-build-command-failed");
  return child.stdout.trim();
}
try {
  const options = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i],
      value = process.argv[i + 1];
    check(
      [
        "--repo",
        "--native-source",
        "--output",
        "--go",
        "--native-commit",
        "--gateway-commit",
      ].includes(key) &&
        value &&
        !options.has(key),
      "joined-build-arguments",
    );
    options.set(key, value);
  }
  const repo = options.get("--repo"),
    native = options.get("--native-source"),
    output = options.get("--output"),
    go = options.get("--go");
  const nativeCommit = options.get("--native-commit"),
    gatewayCommit = options.get("--gateway-commit");
  check(
    repo &&
      native &&
      output &&
      go &&
      [repo, native, output, go].every(isAbsolute) &&
      nativeCommit &&
      /^[a-f0-9]{40}$/.test(nativeCommit) &&
      gatewayCommit &&
      /^[a-f0-9]{40}$/.test(gatewayCommit),
    "joined-build-inputs",
  );
  check(
    command("git", ["rev-parse", "HEAD"], native) === nativeCommit &&
      command("git", ["status", "--porcelain", "--untracked-files=all"], native) === "",
    "joined-build-native-pin",
  );
  check(command("git", ["rev-parse", "HEAD"], repo) === gatewayCommit, "joined-build-gateway-pin");
  check(
    command(go, ["version"], native).startsWith("go version go1.27.3 "),
    "joined-build-go-version",
  );
  check(!existsSync(join(output, "joined-build.json")), "joined-build-fresh-output");
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const hashes = joinedSourceHashes(repo),
    binaries: Record<string, string> = {};
  for (const [client, fixture] of [
    ["claude", "native-claude-joined"],
    ["codex", "native-device-joined"],
  ] as const) {
    const relative = "backend/tmp/" + fixture,
      generated = join(native, relative),
      destination = join(output, fixture);
    check(!existsSync(generated), "joined-build-fresh-fixture");
    check(
      command("git", ["check-ignore", relative + "/main.go"], native) === relative + "/main.go",
      "joined-build-ignored-fixture",
    );
    mkdirSync(generated, { recursive: true, mode: 0o700 });
    mkdirSync(destination, { mode: 0o700 });
    try {
      writeFileSync(
        join(generated, "main.go"),
        readFileSync(
          join(repo, joinedFiles[(client + "Fixture") as "claudeFixture" | "codexFixture"]),
        ),
        { mode: 0o600, flag: "wx" },
      );
      const binary = join(destination, "fixture");
      command(
        go,
        [
          "build",
          "-p=2",
          "-mod=readonly",
          "-trimpath",
          "-buildvcs=true",
          "-ldflags=-s -w",
          "-o",
          binary,
          "./tmp/" + fixture,
        ],
        join(native, "backend"),
      );
      const buildInfo = command(go, ["version", "-m", binary], native);
      check(
        buildInfo.includes("vcs.revision=" + nativeCommit) &&
          buildInfo.includes("vcs.modified=false"),
        "joined-build-provenance",
      );
      binaries[client] = digestFile(binary);
    } finally {
      rmSync(generated, { recursive: true, force: true });
    }
  }
  check(
    command("git", ["status", "--porcelain", "--untracked-files=all"], native) === "",
    "joined-build-native-changed",
  );
  check(
    JSON.stringify(joinedSourceHashes(repo)) === JSON.stringify(hashes),
    "joined-build-source-changed",
  );
  const receipt = {
    kind: "gateway-joined-client-build/v1",
    nativeCommit,
    gatewayCommit,
    goVersion: "go1.27.3",
    sourceHashes: hashes,
    binaries,
  };
  writeFileSync(join(output, "joined-build.json"), JSON.stringify(receipt, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  process.stdout.write(JSON.stringify(receipt) + "\n");
} catch (error) {
  process.stderr.write(
    JSON.stringify({
      outcome: "fail",
      code:
        error instanceof Error && /^joined-build-[a-z-]+$/.test(error.message)
          ? error.message
          : "joined-build-failed",
    }) + "\n",
  );
  process.exitCode = 1;
}
