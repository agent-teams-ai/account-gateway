import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";

const foundationManifest = createRequire(import.meta.url).resolve(
  "@agent-teams/engineering-foundation/package.json",
);
const foundationPackage = JSON.parse(readFileSync(foundationManifest, "utf8"));
const cli = resolve(dirname(foundationManifest), foundationPackage.bin["agent-teams-foundation"]);
const check = (consumer) =>
  spawnSync(
    process.execPath,
    [cli, "check", "architecture.source-dependencies", "--consumer", consumer, "--format", "json"],
    { encoding: "utf8" },
  );
function fixture(body) {
  const root = mkdtempSync(join(tmpdir(), "gateway-source-policy-"));
  try {
    // Copy the actual policy, manifests and governed sources. Mutations never
    // touch the checkout, even if this process is killed before cleanup.
    for (const path of [
      "foundation.config.yaml",
      "architecture/foundation/source-dependencies.yaml",
      "package.json",
      "pnpm-workspace.yaml",
      "packages/account-gateway/package.json",
      "packages/account-gateway/src",
      "services/account-gateway/package.json",
      "services/account-gateway/src",
      "services/account-gateway/test",
    ]) {
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(path, target, { recursive: true });
    }
    if (existsSync("node_modules")) {
      symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
    }
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const passes = (result) => assert.equal(result.status, 0, result.stdout + result.stderr);
const violates = (result) => {
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).outcome, "violations");
};
// Regression: type-only SDK/framework imports bypass the actual installed source policy.
test("valid source profile passes and prohibited type-only import fails", () =>
  fixture((root) => {
    passes(check(root));
    const file = join(
      root,
      "packages/account-gateway/src/features/facade-client/contracts/forbidden-policy-fixture.ts",
    );
    writeFileSync(
      file,
      "import type { ModuleDeclaration } from '@get-modular/core';\nexport type Forbidden = ModuleDeclaration;\n",
    );
    violates(check(root));
    writeFileSync(
      file,
      "import type { FoundationConfig } from '@agent-teams/engineering-foundation';\nexport type Forbidden = FoundationConfig;\n",
    );
    violates(check(root));
  }));

// Regression: module composition bypasses a feature's curated public entrypoint.
test("composition cannot deep-import feature HTTP internals", () =>
  fixture((root) => {
    const file = join(root, "packages/account-gateway/src/get-modular/deep-import-fixture.ts");
    writeFileSync(
      file,
      "import { connect } from '../features/facade-client/http/ingress.js';\nexport const forbidden = connect;\n",
    );
    violates(check(root));
  }));

// Regression: a database/framework dependency enters the private policy domain.
test("private kernel domain rejects a type-only database import without changing source", () => {
  const file = "services/account-gateway/src/domain.ts";
  const original = readFileSync(file);
  fixture((root) => {
    passes(check(root));
    writeFileSync(
      join(root, file),
      Buffer.concat([
        original,
        Buffer.from(
          "\nimport type { Pool } from 'pg';\nexport type ForbiddenKernelDependency = Pool;\n",
        ),
      ]),
    );
    violates(check(root));
    assert.deepEqual(
      readFileSync(file),
      original,
      "policy exercise must leave actual source pristine",
    );
  });
  assert.deepEqual(readFileSync(file), original);
});

// The isolated bearer authority may validate contracts but must not import
// the outer HTTP/transport facade, including through type-only dependencies.
test("bearer authority forbids type-only HTTP facade dependencies", () =>
  fixture((root) => {
    passes(check(root));
    const file = join(root, "services/account-gateway/src/facade-bearers.ts");
    const original = readFileSync(file, "utf8");
    writeFileSync(
      file,
      original +
        "\nimport type { NativeTransport } from './facade.ts';\nexport type ForbiddenBearerDependency = NativeTransport;\n",
    );
    violates(check(root));
  }));

// Regression: the llm domain gains a transport dependency or an adapter bypasses the application entry.
test("llm layers depend inward through public layer entries only", () =>
  fixture((root) => {
    const llm = join(root, "packages/account-gateway/src/features/llm");
    writeFileSync(
      join(llm, "domain/transport-fixture.ts"),
      "import type { ExecutionClient } from '../../facade-client/http/index.js';\nexport type Forbidden = ExecutionClient;\n",
    );
    violates(check(root));
    rmSync(join(llm, "domain/transport-fixture.ts"));
    passes(check(root));
    writeFileSync(
      join(llm, "adapters/deep-import-fixture.ts"),
      "import { createLlmGenerator } from '../application/generate.js';\nexport const forbidden = createLlmGenerator;\n",
    );
    violates(check(root));
  }));
