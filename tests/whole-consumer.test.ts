import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NodeProcessRunner } from "@agent-teams/engineering-foundation/local-mode";

// RED if a stale/mutated copied checker can execute despite the source binding.
void test("whole consumer runs the exact copy and refuses drift before execution", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-whole-copy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "original.mts"),
    consumer = join(root, "consumer");
  await mkdir(consumer);
  const program = 'import {writeFileSync} from "node:fs"; writeFileSync("executed", "original");\n';
  await writeFile(source, program);
  const copy = join(consumer, "consumer-limits-check.mts");
  await writeFile(copy, program);
  const run = () =>
    new NodeProcessRunner().run({
      command: process.execPath,
      args: [resolve("scripts/qualify-whole-consumer.ts"), "run-copy", source, consumer],
      cwd: process.cwd(),
      timeoutMs: 30_000,
    });
  await run();
  assert.equal(await readFile(join(consumer, "executed"), "utf8"), "original");
  await rm(join(consumer, "executed"));
  await writeFile(copy, program.replace('"original"', '"mutated"'));
  await assert.rejects(run(), /whole-consumer.copy-drift/u);
  await assert.rejects(readFile(join(consumer, "executed")), { code: "ENOENT" });
  assert.equal(await readFile(source, "utf8"), program);
});

// Native filesystem cases: physical source ancestry must refuse before install.
void test("consumer destination guard preserves physical ancestry and existing-path refusal", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-whole-destination-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source"),
    outside = join(root, "outside");
  await mkdir(source);
  await mkdir(outside);
  await symlink(source, join(root, "source-alias"));
  await symlink(outside, join(root, "outside-alias"));
  const archive = join(root, "archive.tgz");
  await writeFile(archive, "");
  const runner = new NodeProcessRunner();
  const guard = (destination: string) =>
    runner.run({
      command: "/bin/bash",
      args: [resolve("scripts/qualify-consumers.sh"), archive, destination],
      cwd: source,
      timeoutMs: 30_000,
    });
  await assert.rejects(
    guard(join(root, "source-alias", "missing", "nested")),
    /Use a directory outside the source workspace/u,
  );
  await assert.rejects(readFile(join(source, "missing", "nested", "a", "package.json")), {
    code: "ENOENT",
  });
  const file = join(root, "existing-file"),
    link = join(root, "existing-link");
  await writeFile(file, "existing");
  await symlink(file, link);
  for (const destination of [outside, file, link]) {
    await assert.rejects(guard(destination), /Qualification directory must be absent/u);
  }
  const dangling = join(root, "dangling-link");
  await symlink(join(root, "missing-target"), dangling);
  await assert.rejects(guard(dangling), /ENOENT/u);
  const destination = join(root, "outside-alias", "missing", "nested");
  const canonical = await runner.run({
    command: process.execPath,
    args: [resolve("scripts/qualify-whole-consumer.ts"), "destination", destination],
    cwd: source,
    timeoutMs: 30_000,
  });
  assert.equal(canonical.stdout.trim(), join(outside, "missing", "nested"));
  await assert.rejects(readFile(join(outside, "missing", "nested")), { code: "ENOENT" });
});
