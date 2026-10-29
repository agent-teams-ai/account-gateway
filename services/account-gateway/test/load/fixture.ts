import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { createHash } from "node:crypto";
import { check, bounds } from "./model.ts";

export interface Fixture {
  kind: "account-gateway-fullstack-fixture-v1";
  runId: string;
  seed: number;
  root: string;
  artifacts: string;
  kernelDSN: string;
  nativeDSN: string;
  gatewayCommit: string;
  native: {
    executable: string;
    sha256: string;
    sourceCommit: string;
    migrationsSha256: string;
    migrationFiles: { name: string; sha256: string }[];
  };
  tls: { ca: string; cert: string; key: string };
  network: { externalDisabled: true; evidence: Record<string, string | boolean | number> };
}
export const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
export function protectedPath(path: string, mode?: number) {
  check(isAbsolute(path) && normalize(path) === path && !path.includes("\0"), "protected-path");
  for (let ancestor = dirname(path); ; ancestor = dirname(ancestor)) {
    const s = lstatSync(ancestor);
    check(s.isDirectory() && s.uid === 0 && !(s.mode & 0o022), "protected-ancestor");
    if (ancestor === "/") {
      break;
    }
  }
  const s = lstatSync(path);
  check(s.uid === 0 && !(s.mode & 0o022) && !s.isSymbolicLink(), "protected-owner");
  if (mode !== undefined) {
    check((s.mode & 0o777) === mode, "protected-mode");
  }
  return s;
}
export function readProtected(path: string, cap = 65_536): Buffer {
  const state = protectedPath(path, 0o600);
  check(state.isFile() && state.nlink === 1 && state.size <= cap, "protected-file");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    check(
      stat.dev === state.dev && stat.ino === state.ino && stat.size <= cap,
      "protected-file-race",
    );
    const b = Buffer.alloc(cap + 1);
    let size = 0,
      n: number;
    do {
      n = readSync(fd, b, size, b.length - size, size);
      size += n;
    } while (n && size < b.length);
    check(size <= cap, "protected-input-bound");
    return b.subarray(0, size);
  } finally {
    closeSync(fd);
  }
}
export function loadFixture(path: string): Fixture {
  check(
    process.platform === "linux" &&
      process.geteuid?.() === 0 &&
      ["v26.11.1", "v24.21.0"].includes(process.version),
    "required-runtime",
  );
  const f = JSON.parse(readProtected(path).toString("utf8")) as Fixture;
  check(
    Object.is(f.kind, "account-gateway-fullstack-fixture-v1") &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(f.runId) &&
      Number.isSafeInteger(f.seed) &&
      f.seed >= 0 &&
      f.seed <= 0xffffffff,
    "manifest-identity",
  );
  check(
    /^[a-f0-9]{40}$/.test(f.gatewayCommit) && /^[a-f0-9]{40}$/.test(f.native.sourceCommit),
    "source-commits",
  );
  check(
    protectedPath(f.root, 0o700).isDirectory() && protectedPath(f.artifacts, 0o700).isDirectory(),
    "fixture-directories",
  );
  check(
    readdirSync(f.root).every((name) => ["fixture.json", "native", "tls"].includes(name)),
    "fresh-protected-root",
  );
  const image = protectedPath(f.native.executable);
  check(image.isFile() && image.nlink === 1 && image.mode & 0o100, "native-image");
  check(
    /^[a-f0-9]{64}$/.test(f.native.sha256) &&
      sha256(readFileSync(f.native.executable)) === f.native.sha256,
    "native-image-hash",
  );
  for (const certificatePath of [f.tls.ca, f.tls.cert]) {
    check(protectedPath(certificatePath).isFile(), "tls-input");
  }
  check(protectedPath(f.tls.key, 0o600).isFile(), "tls-private-input");
  for (const dsn of [f.kernelDSN, f.nativeDSN]) {
    const u = new URL(dsn);
    check(
      ["postgres:", "postgresql:"].includes(u.protocol) &&
        u.hostname === "127.0.0.1" &&
        !!u.port &&
        Number(u.port) >= 1024 &&
        !u.password &&
        !u.hash &&
        (!u.search || u.search === "?sslmode=disable") &&
        /^\/ag_load_[a-z0-9_]{1,55}$/.test(u.pathname),
      "designated-disposable-database",
    );
  }
  check(new URL(f.kernelDSN).pathname !== new URL(f.nativeDSN).pathname, "separate-databases");
  check(
    Array.isArray(f.native.migrationFiles) &&
      f.native.migrationFiles.length > 0 &&
      f.native.migrationFiles.length < 1000 &&
      f.native.migrationFiles.every(
        (x) => /^[A-Za-z0-9_.-]+\.sql$/.test(x.name) && /^[a-f0-9]{64}$/.test(x.sha256),
      ),
    "native-migration-manifest",
  );
  const sorted = [...f.native.migrationFiles].toSorted((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  check(
    new Set(sorted.map((x) => x.name)).size === sorted.length &&
      sha256(sorted.map((x) => x.name + "\0" + x.sha256 + "\n").join("")) ===
        f.native.migrationsSha256,
    "native-migrations-digest",
  );
  check(
    Object.is(f.network.externalDisabled, true) && Object.keys(f.network.evidence).length <= 32,
    "network-attestation",
  );
  // Independently inspect this process's actual namespace. No non-loopback
  // interfaces or IPv4 routes may exist during the measured run.
  const links = readFileSync("/proc/net/dev", "utf8")
    .trim()
    .split("\n")
    .slice(2)
    .map((line) => line.split(":")[0].trim());
  const routes = readFileSync("/proc/net/route", "utf8").trim().split("\n").slice(1);
  check(
    links.every((name) => name === "lo") && routes.every((line) => line.trim().startsWith("lo\t")),
    "external-network-disabled",
  );
  check(process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0", "normal-tls-required");
  return f;
}
export function sourceManifest(workspace: string) {
  const paths: string[] = [];
  const walk = (relative: string) => {
    for (const name of readdirSync(join(workspace, relative)).toSorted()) {
      const path = join(relative, name),
        s = lstatSync(join(workspace, path));
      if (s.isDirectory()) {
        walk(path);
      } else if (s.isFile()) {
        paths.push(path);
      }
    }
  };
  for (const directory of [
    "services/account-gateway/src",
    "services/account-gateway/test/load",
    "services/account-gateway/migrations",
    "packages/account-gateway/src",
  ]) {
    walk(directory);
  }
  paths.push(
    "package.json",
    "pnpm-lock.yaml",
    "services/account-gateway/package.json",
    "packages/account-gateway/package.json",
  );
  const files = paths
    .toSorted()
    .map((path) => ({ path, sha256: sha256(readFileSync(join(workspace, path))) }));
  check(JSON.stringify(files).length < bounds.artifactBytes / 16, "source-manifest-bound");
  return { files, sha256: sha256(files.map((x) => x.path + "\0" + x.sha256 + "\n").join("")) };
}
