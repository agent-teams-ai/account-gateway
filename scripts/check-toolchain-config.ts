import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ordinaryProjects = [
  "tsconfig.tests.json",
  "tsconfig.consumer-pin.json",
  "services/account-gateway/tsconfig.json",
];
const fail = (code: string): never => {
  throw new Error(`toolchain.config.${code}`);
};
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("record");
  }
  return value as Record<string, unknown>;
}
async function json(root: string, path: string): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(resolve(root, path), "utf8")) as unknown;
  } catch {
    return fail("unreadable-json");
  }
  return record(value);
}
function samePaths(value: unknown, expected: readonly string[], code: string): void {
  if (
    !Array.isArray(value) ||
    value.length !== expected.length ||
    !value.every((path: unknown) => typeof path === "string" && expected.includes(path)) ||
    new Set(value).size !== expected.length
  ) {
    return fail(code);
  }
}

// Consumer scope policy only. Public Stack still owns configuration parsing and checking.
export async function checkToolchainConfiguration(root: string): Promise<void> {
  const toolchain = await json(root, "toolchain.config.json");
  samePaths(record(toolchain.typecheck).projects, ordinaryProjects, "ordinary-projects");
  // The maintained CI profile uses adjacent single-line run steps; other forms
  // require explicit policy review rather than a permissive workflow parser.
  const checkpoint = await readFile(resolve(root, ".github/workflows/checkpoint-a.yaml"), "utf8");
  const laneStart = checkpoint.indexOf("\njobs:\n  qualify_runtime:\n");
  const laneEnd = checkpoint.indexOf("\n  qualify:\n", laneStart);
  const runner = 'node "$RUNNER_TEMP/gateway-pnpm/node_modules/pnpm/bin/pnpm.cjs" run ';
  const qualitySteps = ["build", "lint", "format:check", "typecheck"]
    .map((command) => `      - run: ${runner}${command}`)
    .join("\n");
  if (
    laneStart < 0 ||
    laneEnd < laneStart ||
    !checkpoint.slice(laneStart, laneEnd).includes(qualitySteps)
  ) {
    return fail("ci-quality");
  }
  samePaths(
    (await json(root, "tsconfig.tests.json")).include,
    ["tests/**/*.mts", "tests/whole-consumer.test.ts"],
    "test-scope",
  );
  samePaths(
    (await json(root, "tsconfig.consumer-pin.json")).include,
    [
      "scripts/check-consumer-pin.ts",
      "scripts/check-toolchain-config.ts",
      "tests/consumer-module-pin.test.ts",
      "scripts/qualify-whole-consumer.ts",
      "scripts/consumer-limits-check.mts",
    ],
    "pin-script-scope",
  );
  const manifest = await json(root, "package.json");
  if (record(manifest.devDependencies)["@agent-teams/account-gateway"] !== "workspace:*") {
    return fail("sdk-workspace");
  }
  const testCommand = record(manifest.scripts).test;
  if (
    typeof testCommand !== "string" ||
    !testCommand.split(/\s+/u).includes("tests/whole-consumer.test.ts")
  ) {
    return fail("whole-test-inventory");
  }
  const solution = await json(root, "tsconfig.json");
  if (
    Object.keys(solution).toSorted().join(",") !== "files,references" ||
    !Array.isArray(solution.files) ||
    solution.files.length !== 0 ||
    !Array.isArray(solution.references)
  ) {
    return fail("solution-index");
  }
  const references = solution.references.map((value: unknown) => {
    const row = record(value);
    if (
      Object.keys(row).join(",") !== "path" ||
      typeof row.path !== "string" ||
      !row.path.startsWith("./")
    ) {
      return fail("solution-reference");
    }
    return row.path.slice(2);
  });
  samePaths(references, ["tsconfig.build.json", ...ordinaryProjects], "solution-projects");
  const build = await json(root, "tsconfig.build.json");
  const options = record(build.compilerOptions);
  if (
    options.strict !== true ||
    options.skipLibCheck !== false ||
    options.noCheck === true ||
    options.noEmit === true ||
    options.composite === true ||
    options.declaration !== true
  ) {
    return fail("build-strictness");
  }
  if (
    options.rootDir !== "packages/account-gateway/src" ||
    options.outDir !== "packages/account-gateway/dist" ||
    "references" in build
  ) {
    return fail("build-scope");
  }
  samePaths(build.include, ["packages/account-gateway/src/**/*.ts"], "build-scope");
  for (const path of ordinaryProjects) {
    const project = await json(root, path);
    if ("references" in project) {
      return fail("ordinary-references");
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await checkToolchainConfiguration(resolve(process.argv[2] ?? "."));
    console.log("Toolchain project topology PASS");
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : "toolchain.config.failed");
    process.exitCode = 1;
  }
}
