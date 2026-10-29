import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  chownSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { artifactNames, openArtifactExport } from "./artifact-export.ts";
import { bounds } from "./model.ts";

function fixture(work: (root: string, source: string, destination: string) => void) {
  const root = mkdtempSync("/tmp/gateway-artifact-export-"),
    source = join(root, "source"),
    destination = join(root, "destination");
  mkdirSync(source, { mode: 0o700 });
  mkdirSync(destination, { mode: 0o700 });
  try {
    work(root, source, destination);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const code = (expected: string) => (error: unknown) =>
  error !== null && typeof error === "object" && "code" in error && error.code === expected;
const fdCount = () => readdirSync("/proc/self/fd").length;

void test("artifact export copies only allowlisted regular evidence with exact bytes, private modes and closed descriptors", () => {
  fixture((_root, source, destination) => {
    const before = fdCount(),
      evidence = Buffer.alloc(150_001, 0x61);
    const exporter = openArtifactExport(destination);
    try {
      for (const name of artifactNames) {
        writeFileSync(join(source, name), evidence, { mode: 0o600 });
        exporter.copy(source, name);
        assert.equal(Buffer.compare(readFileSync(join(destination, name)), evidence), 0);
        assert.equal(statSync(join(destination, name)).mode & 0o777, 0o600);
      }
      assert.deepEqual(readdirSync(destination).toSorted(), [...artifactNames].toSorted());
    } finally {
      exporter.close();
    }
    exporter.close();
    assert.equal(fdCount(), before);
    assert.throws(() => {
      exporter.copy(source, "summary.json");
    }, /load:artifact-export-closed/);
  });
});

void test("artifact export refuses a preexisting destination and later leaf files or symlinks without changing target bytes or mode", () => {
  fixture((root, source, destination) => {
    const before = fdCount();
    const target = join(root, "target");
    writeFileSync(target, "untouched", { mode: 0o640 });
    writeFileSync(join(source, "summary.json"), "new evidence", { mode: 0o600 });
    writeFileSync(join(destination, "existing"), "existing", { mode: 0o600 });
    assert.throws(() => openArtifactExport(destination), /load:artifact-export-fresh-directory/);
    rmSync(join(destination, "existing"));
    const exporter = openArtifactExport(destination);
    try {
      symlinkSync(target, join(destination, "summary.json"));
      assert.throws(() => {
        exporter.copy(source, "summary.json");
      }, code("EEXIST"));
      assert.equal(readFileSync(target, "utf8"), "untouched");
      assert.equal(statSync(target).mode & 0o777, 0o640);
      rmSync(join(destination, "summary.json"));
      writeFileSync(join(destination, "summary.json"), "old evidence", { mode: 0o400 });
      assert.throws(() => {
        exporter.copy(source, "summary.json");
      }, code("EEXIST"));
      assert.equal(readFileSync(join(destination, "summary.json"), "utf8"), "old evidence");
      assert.equal(statSync(join(destination, "summary.json")).mode & 0o777, 0o400);
    } finally {
      exporter.close();
    }
    assert.equal(fdCount(), before);
  });
});

void test("artifact export stays on its pinned directory when its destination or an ancestor is replaced", () => {
  fixture((root, source, destination) => {
    const before = fdCount(),
      exporter = openArtifactExport(destination),
      retained = join(root, "retained");
    writeFileSync(join(source, "summary.json"), "pinned evidence", { mode: 0o600 });
    renameSync(destination, retained);
    mkdirSync(destination, { mode: 0o700 });
    const target = join(root, "target");
    writeFileSync(target, "untouched", { mode: 0o640 });
    symlinkSync(target, join(destination, "summary.json"));
    try {
      exporter.copy(source, "summary.json");
      assert.equal(readFileSync(join(retained, "summary.json"), "utf8"), "pinned evidence");
      assert.equal(readFileSync(target, "utf8"), "untouched");
      assert.equal(statSync(target).mode & 0o777, 0o640);
    } finally {
      exporter.close();
    }
    const parent = join(root, "parent"),
      moved = join(root, "moved");
    mkdirSync(parent, { mode: 0o700 });
    const nested = join(parent, "evidence");
    mkdirSync(nested, { mode: 0o700 });
    const nestedExporter = openArtifactExport(nested);
    renameSync(parent, moved);
    mkdirSync(parent, { mode: 0o700 });
    symlinkSync(destination, nested);
    try {
      nestedExporter.copy(source, "summary.json");
      assert.equal(
        readFileSync(join(moved, "evidence", "summary.json"), "utf8"),
        "pinned evidence",
      );
      assert.equal(readFileSync(target, "utf8"), "untouched");
      assert.equal(statSync(target).mode & 0o777, 0o640);
    } finally {
      nestedExporter.close();
    }
    assert.equal(fdCount(), before);
  });
});

void test("artifact export rejects unsafe directory modes, symlink directories, non-allowlisted names and invalid source paths without FD leaks", () => {
  fixture((root, source, destination) => {
    const before = fdCount();
    chmodSync(destination, 0o755);
    for (let n = 0; n < 16; n++) {
      assert.throws(() => openArtifactExport(destination), /load:artifact-export-private-owner/);
    }
    chmodSync(destination, 0o700);
    // A root operator can open somebody else's private directory; its explicit
    // owner check must still reject it. Nonroot runs lack that DAC bypass.
    if (process.geteuid?.() === 0) {
      chownSync(destination, 65534, 65534);
      try {
        assert.throws(() => openArtifactExport(destination), /load:artifact-export-private-owner/);
      } finally {
        chownSync(destination, 0, 0);
      }
    }
    const alias = join(root, "alias");
    symlinkSync(destination, alias);
    assert.throws(() => openArtifactExport(alias));
    const exporter = openArtifactExport(destination);
    try {
      for (const name of [
        "../summary.json",
        "/summary.json",
        "secret.json",
        "summary.json/child",
        "summary.json\0other",
      ]) {
        assert.throws(() => {
          exporter.copy(source, name);
        }, /load:artifact-export-name/);
      }
      assert.throws(() => {
        exporter.copy("relative", "summary.json");
      }, /load:artifact-export-path/);
      assert.throws(() => {
        exporter.copy(source + "/../source", "summary.json");
      }, /load:artifact-export-path/);
      symlinkSync(source, join(root, "source-alias"));
      assert.throws(() => {
        exporter.copy(join(root, "source-alias"), "summary.json");
      });
      for (let n = 0; n < 16; n++) {
        assert.throws(() => {
          exporter.copy(source, "summary.json");
        }, code("ENOENT"));
      }
      assert.deepEqual(readdirSync(destination), []);
    } finally {
      exporter.close();
    }
    assert.equal(fdCount(), before);
  });
});

void test("artifact export rejects source symlinks, directories, hard links and oversized files before creating output", () => {
  fixture((root, source, destination) => {
    const before = fdCount(),
      exporter = openArtifactExport(destination),
      path = join(source, "summary.json");
    const target = join(root, "target");
    writeFileSync(target, "not exported", { mode: 0o640 });
    try {
      symlinkSync(target, path);
      assert.throws(() => {
        exporter.copy(source, "summary.json");
      });
      rmSync(path);
      linkSync(target, path);
      assert.throws(() => {
        exporter.copy(source, "summary.json");
      }, /load:artifact-export-source-bound/);
      rmSync(path);
      mkdirSync(path, { mode: 0o700 });
      assert.throws(() => {
        exporter.copy(source, "summary.json");
      }, /load:artifact-export-source-bound/);
      rmSync(path, { recursive: true });
      writeFileSync(path, "", { mode: 0o600 });
      truncateSync(path, bounds.artifactBytes + 1);
      for (let n = 0; n < 16; n++) {
        assert.throws(() => {
          exporter.copy(source, "summary.json");
        }, /load:artifact-export-source-bound/);
      }
      assert.deepEqual(readdirSync(destination), []);
      assert.equal(readFileSync(target, "utf8"), "not exported");
      assert.equal(statSync(target).mode & 0o777, 0o640);
    } finally {
      exporter.close();
    }
    assert.equal(fdCount(), before);
  });
});
