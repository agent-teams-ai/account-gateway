import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

interface Solution {
  files: string[];
  references: { path: string }[];
}
interface Toolchain {
  typecheck: { projects: string[] };
}
interface Build {
  include: string[];
  compilerOptions: { strict: boolean };
}
const authorities = [
  ".github/workflows/checkpoint-a.yaml",
  "package.json",
  "toolchain.config.json",
  "tsconfig.json",
  "tsconfig.build.json",
  "tsconfig.tests.json",
  "tsconfig.consumer-pin.json",
  "services/account-gateway/tsconfig.json",
];
const entry = resolve("scripts/check-toolchain-config.ts");
const check = (root: string) => spawnSync(process.execPath, [entry, root], { encoding: "utf8" });
async function fixture(body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "gateway-toolchain-topology-"));
  try {
    for (const path of authorities) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await cp(path, join(root, path));
    }
    assert.equal(check(root).status, 0, "actual repository configuration must qualify");
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
function rejected(root: string, code: string): void {
  const result = check(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(result.stderr.includes(`toolchain.config.${code}`), result.stderr);
}

// A missing or duplicate discovery edge hides a real project from typed lint.
void test("solution discovery rejects missing and duplicate project references", async () => {
  await fixture(async (root) => {
    const path = join(root, "tsconfig.json");
    const original = JSON.parse(await readFile(path, "utf8")) as Solution;
    for (const references of [
      original.references.slice(1),
      [original.references[0], original.references[0], ...original.references.slice(2)],
    ]) {
      await writeFile(path, JSON.stringify({ ...original, references }));
      rejected(root, "solution-projects");
    }
  });
});
// Coordinating both lists must not remove the private service qualification lane.
void test("coordinated index and checker project deletion cannot shrink service coverage", async () => {
  await fixture(async (root) => {
    const toolchain = JSON.parse(
      await readFile(join(root, "toolchain.config.json"), "utf8"),
    ) as Toolchain;
    const solution = JSON.parse(await readFile(join(root, "tsconfig.json"), "utf8")) as Solution;
    toolchain.typecheck.projects = toolchain.typecheck.projects.filter(
      (p) => p !== "services/account-gateway/tsconfig.json",
    );
    solution.references = solution.references.filter(
      (p) => p.path !== "./services/account-gateway/tsconfig.json",
    );
    await writeFile(join(root, "toolchain.config.json"), JSON.stringify(toolchain));
    await writeFile(join(root, "tsconfig.json"), JSON.stringify(solution));
    rejected(root, "ordinary-projects");
  });
});
// SDK emission cannot start including tests or silently stop strict library checking.
void test("SDK build authority rejects broadened inputs and weaker compiler settings", async () => {
  await fixture(async (root) => {
    const path = join(root, "tsconfig.build.json");
    const original = JSON.parse(await readFile(path, "utf8")) as Build;
    await writeFile(path, JSON.stringify({ ...original, include: ["**/*.ts"] }));
    rejected(root, "build-scope");
    await writeFile(
      path,
      JSON.stringify({
        ...original,
        compilerOptions: { ...original.compilerOptions, strict: false },
      }),
    );
    rejected(root, "build-strictness");
  });
});

// A new ordinary .ts tool or its regression must not silently leave strict/test coverage.
void test("whole-consumer qualification rejects missing strict inputs or runtime inventory", async () => {
  for (const [path, target, code] of [
    ["tsconfig.tests.json", "tests/whole-consumer.test.ts", "test-scope"],
    ["tsconfig.consumer-pin.json", "scripts/qualify-whole-consumer.ts", "pin-script-scope"],
    ["tsconfig.consumer-pin.json", "scripts/consumer-limits-check.mts", "pin-script-scope"],
    ["package.json", "tests/whole-consumer.test.ts", "whole-test-inventory"],
  ]) {
    await fixture(async (root) => {
      const file = join(root, path);
      const original = await readFile(file, "utf8");
      await writeFile(file, original.replace(target, "removed-qualification.ts"));
      rejected(root, code);
    });
  }
});

void test("whole checker rejects missing or redirected SDK workspace ownership", async () => {
  for (const replacement of [
    "",
    '"@agent-teams/account-gateway": "file:./packages/account-gateway",',
  ]) {
    await fixture(async (root) => {
      const path = join(root, "package.json");
      const original = await readFile(path, "utf8");
      const edge = '"@agent-teams/account-gateway": "workspace:*",';
      assert.ok(original.includes(edge));
      await writeFile(path, original.replace(edge, replacement));
      rejected(root, "sdk-workspace");
    });
  }
});

// Removing a quality command or placing it before SDK emission must refuse CI.
void test("ordinary CI requires public lint and format after SDK build", async () => {
  for (const change of ["lint", "format:check", "order"]) {
    await fixture(async (root) => {
      const path = join(root, ".github/workflows/checkpoint-a.yaml");
      const original = await readFile(path, "utf8");
      const prefix =
        '      - run: node "$RUNNER_TEMP/gateway-pnpm/node_modules/pnpm/bin/pnpm.cjs" run ';
      const build = prefix + "build\n",
        lint = prefix + "lint\n",
        format = prefix + "format:check\n";
      const altered =
        change === "order"
          ? original.replace(build + lint + format, lint + format + build)
          : original.replace(prefix + change + "\n", "");
      assert.notEqual(altered, original, "fixture must alter an actual CI command");
      await writeFile(path, altered);
      rejected(root, "ci-quality");
    });
  }
});
