import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, realpathSync, lstatSync } from "node:fs";
import { relative, isAbsolute, join, resolve, dirname, basename } from "node:path";
import { NodeProcessRunner } from "@agent-teams/engineering-foundation/local-mode";

const checker = "consumer-limits-check.mts";
const closure = "limits-closure.mts";
const runner = new NodeProcessRunner();
const cancellation = new AbortController();
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function json(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(record(value), "whole-consumer.json");
  return value;
}
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
function declarations(root: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".d.ts"))
      .toSorted()
      .map((name): [string, string] => [name, digest(join(root, name))]),
  );
}
function contained(root: string, path: string): string {
  const actual = realpathSync(path),
    suffix = relative(realpathSync(root), actual);
  assert.ok(
    suffix !== "" && !suffix.startsWith("..") && !isAbsolute(suffix),
    "whole-consumer.physical-boundary",
  );
  return actual;
}
function canonicalDestination(path: string): string {
  const missing: string[] = [];
  let ancestor = resolve(path);
  while (lstatSync(ancestor, { throwIfNoEntry: false }) === undefined) {
    missing.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  return resolve(realpathSync(ancestor), ...missing);
}
function boundCopy(source: string, consumer: string): string {
  const copy = contained(consumer, join(consumer, checker));
  assert.equal(digest(copy), digest(source), "whole-consumer.copy-drift");
  assert.deepEqual(readFileSync(copy), readFileSync(source), "whole-consumer.copy-drift");
  return copy;
}
async function runCopy(source: string, consumer: string): Promise<void> {
  const copy = boundCopy(source, consumer);
  const output = await runner.run({
    command: process.execPath,
    args: [copy],
    cwd: consumer,
    timeoutMs: 300_000,
    signal: cancellation.signal,
  });
  writeFileSync(join(consumer, "whole-runtime.log"), output.stdout + output.stderr);
  boundCopy(source, consumer);
}
function configuration(consumer: string, resolution: string, complete: boolean): void {
  const project = complete ? "tsconfig.json" : "tsconfig.whole.json";
  writeFileSync(
    join(consumer, project),
    JSON.stringify({
      compilerOptions: {
        module: resolution === "NodeNext" ? "NodeNext" : "ESNext",
        moduleResolution: resolution,
        target: "ES2024",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: ["node"],
      },
      files: complete ? [checker, closure] : [checker],
    }),
  );
  writeFileSync(
    join(consumer, "toolchain.config.json"),
    JSON.stringify({
      schemaVersion: 1,
      profile: "typescript-node",
      typecheck: { projects: [project] },
      lint: { config: ".oxlintrc.json", paths: complete ? [checker, closure] : [checker] },
      format: { paths: [checker] },
    }),
  );
  writeFileSync(
    join(consumer, ".oxlintrc.json"),
    JSON.stringify({ extends: ["./node_modules/stack-toolchain/presets/oxlint/type-aware.json"] }),
  );
}
function prepare(source: string, consumer: string, archive: string): void {
  const pins = json(join(source, "package.json")).devDependencies;
  assert.ok(record(pins));
  const devDependencies: Record<string, string> = {};
  for (const name of ["stack-toolchain", "typescript", "@types/node"]) {
    const pin = pins[name];
    assert.ok(typeof pin === "string" && /^\d+\.\d+\.\d+$/u.test(pin), "whole-consumer.exact-pin");
    devDependencies[name] = pin;
  }
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: { "@agent-teams/account-gateway": archive },
      devDependencies,
    }),
  );
}
async function qualify(
  source: string,
  consumer: string,
  archive: string,
  resolution: string,
): Promise<void> {
  assert.ok(resolution === "NodeNext" || resolution === "Bundler");
  assert.equal(process.env.NODE_PATH, undefined, "whole-consumer.ambient-path");
  assert.equal(process.env.NODE_OPTIONS, undefined, "whole-consumer.node-hooks");
  const original = join(source, "scripts", checker),
    copy = boundCopy(original, consumer),
    originalBytes = readFileSync(original);
  const originalHash = digest(original),
    archiveHash = digest(archive);
  const modules = contained(consumer, join(consumer, "node_modules"));
  const sdk = contained(modules, join(modules, "@agent-teams/account-gateway"));
  const cli = contained(modules, join(modules, "stack-toolchain/dist/cli.js"));
  const expected = json(join(source, "packages/account-gateway/package.json")),
    installed = json(join(sdk, "package.json"));
  assert.equal(expected.name, "@agent-teams/account-gateway");
  assert.equal(installed.name, expected.name);
  assert.equal(typeof expected.version, "string");
  assert.ok(record(expected.exports) && record(installed.exports));
  assert.equal(installed.version, expected.version);
  assert.deepEqual(installed.exports, expected.exports);
  const dts = declarations(join(source, "packages/account-gateway/dist"));
  assert.ok(Object.keys(dts).length > 0, "whole-consumer.declarations-empty");
  assert.deepEqual(declarations(join(sdk, "dist")), dts);
  const packages = json(join(consumer, "package-lock.json")).packages;
  assert.ok(record(packages) && record(packages["node_modules/@agent-teams/account-gateway"]));
  const sri = "sha512-" + createHash("sha512").update(readFileSync(archive)).digest("base64");
  assert.equal(packages["node_modules/@agent-teams/account-gateway"].integrity, sri);
  const observations: unknown[] = [];
  async function stack(phase: string, command: string, expectedCode = 0): Promise<string> {
    const log = join(consumer, `whole-${phase}.json`),
      stderr = join(consumer, `whole-${phase}.stderr`),
      status = join(consumer, `whole-${phase}.status`);
    await runner.run({
      command: "/bin/sh",
      args: [
        "-c",
        '"$1" "$2" "$3" --json >"$4" 2>"$5"; result=$?; printf "%s" "$result" >"$6"',
        "whole-consumer",
        process.execPath,
        cli,
        command,
        log,
        stderr,
        status,
      ],
      cwd: consumer,
      timeoutMs: 300_000,
      signal: cancellation.signal,
    });
    const code = readFileSync(status, "utf8");
    observations.push({
      phase,
      command,
      code,
      reportSha256: digest(log),
      stderrSha256: digest(stderr),
    });
    writeFileSync(join(consumer, "whole-observations.json"), JSON.stringify(observations, null, 2));
    assert.equal(code, String(expectedCode), `whole-consumer.${phase}`);
    return readFileSync(log, "utf8");
  }
  configuration(consumer, resolution, false);
  await stack("doctor", "doctor");
  const doctor = json(join(consumer, "whole-doctor.json"));
  assert.ok(record(doctor.details));
  const pins = json(join(source, "package.json")).devDependencies;
  assert.ok(record(pins));
  assert.equal(doctor.details.packageVersion, pins["stack-toolchain"]);
  await stack("whole-before-runtime", "typecheck");
  // No tsconfig.json yet: the unchanged checker invokes TS7 with explicit files.
  await runCopy(original, consumer);
  configuration(consumer, resolution, true);
  const generated = digest(join(consumer, closure));
  await stack("whole-and-closure", "typecheck");
  await stack("whole-and-closure-lint", "lint");
  const mutants = [
    {
      phase: "compiler-negative",
      command: "typecheck",
      text: '\nconst wholeCompilerProbe: number = "wrong";\n',
      diagnostic: /2322|not assignable/u,
    },
    {
      phase: "lint-negative",
      command: "lint",
      text: "\nconst wholeLintProbe = JSON.parse('{\"marker\":1}');\nvoid wholeLintProbe.marker;\n",
      diagnostic: /no-unsafe-assignment|no-unsafe-member-access/u,
    },
  ];
  for (const mutant of mutants) {
    try {
      writeFileSync(copy, Buffer.concat([originalBytes, Buffer.from(mutant.text)]));
      assert.throws(() => boundCopy(original, consumer), /whole-consumer.copy-drift/u);
      assert.match(await stack(mutant.phase, mutant.command, 1), mutant.diagnostic);
    } finally {
      writeFileSync(copy, originalBytes);
      boundCopy(original, consumer);
    }
  }
  assert.equal(digest(original), originalHash);
  assert.equal(digest(archive), archiveHash);
  assert.equal(digest(join(consumer, closure)), generated);
  assert.deepEqual(declarations(join(source, "packages/account-gateway/dist")), dts);
  assert.deepEqual(declarations(join(sdk, "dist")), dts);
  writeFileSync(
    join(consumer, "whole-qualification.json"),
    JSON.stringify(
      {
        status: "PASS",
        registryQualification: false,
        runtime: process.version,
        resolution,
        sourceSha256: originalHash,
        copySha256: digest(copy),
        generatedSha256: generated,
        archiveSha256: archiveHash,
        archiveSRI: sri,
        sdkVersion: installed.version,
        exports: installed.exports,
        declarations: dts,
        lockSha256: digest(join(consumer, "package-lock.json")),
        observations,
      },
      null,
      2,
    ),
  );
}
async function main(): Promise<void> {
  const [mode, input, destination, archive, resolution] = process.argv.slice(2);
  assert.ok(typeof input === "string", "whole-consumer.arguments");
  if (mode === "destination") {
    console.log(canonicalDestination(input));
    return;
  }
  assert.ok(typeof destination === "string", "whole-consumer.arguments");
  const source = realpathSync(input),
    consumer = realpathSync(destination);
  if (mode === "run-copy") {
    await runCopy(source, consumer);
  } else {
    assert.ok(typeof archive === "string");
    if (mode === "prepare") {
      prepare(source, consumer, realpathSync(archive));
    } else {
      assert.equal(mode, "qualify");
      assert.ok(typeof resolution === "string");
      await qualify(source, consumer, realpathSync(archive), resolution);
    }
  }
}
const abort = () => {
  cancellation.abort();
};
process.once("SIGINT", abort);
process.once("SIGTERM", abort);
try {
  await main();
} finally {
  process.removeListener("SIGINT", abort);
  process.removeListener("SIGTERM", abort);
}
