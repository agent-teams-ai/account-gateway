// Disposable CI profile only. The pinned CLI and its own sandbox are unchanged.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

export const defaultSeccompSHA256 =
  "1a4d017730647621403920d9558aa0152adef04dd89ed7720e4abafa24551999";
export const codexSHA256 = "524396258c974948334eabe6f2c6b1d8e1979dfd048d67d535ad9e4550fa5b26";
export const bwrapSHA256 = "90604f553d1fc200c6b23f53ef80a58f952e9b50e2716cb590f7e1bfa0f27b27";
export const capabilities = [
  "AUDIT_WRITE",
  "CHOWN",
  "DAC_OVERRIDE",
  "FOWNER",
  "FSETID",
  "KILL",
  "MKNOD",
  "NET_BIND_SERVICE",
  "NET_RAW",
  "SETFCAP",
  "SETGID",
  "SETPCAP",
  "SETUID",
  "SYS_CHROOT",
] as const;
export const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const fileDigest = (path: string) => digest(readFileSync(path));
export function safePath(path: string): string {
  assert.ok(isAbsolute(path) && normalize(path) === path && /^[A-Za-z0-9_./-]+$/.test(path));
  assert.ok(path !== "/" && !path.includes("//") && !path.endsWith("/"));
  return path;
}
export function safeProfileName(name: string): string {
  assert.match(name, /^gateway-joined-[a-f0-9]{24}$/);
  return name;
}
export interface ProfilePaths {
  readonly root: string;
  readonly nodeHome: string;
  readonly goHome: string;
}
export function createSeccomp(): object {
  const bytes = readFileSync(new URL("./docker-seccomp-default.fixture", import.meta.url));
  assert.equal(digest(bytes), defaultSeccompSHA256);
  const profile = JSON.parse(bytes.toString("utf8")) as {
    defaultAction: string;
    syscalls: Array<Record<string, unknown>>;
  };
  assert.equal(profile.defaultAction, "SCMP_ACT_ERRNO");
  // Preserve all upstream rules, including clone3 ENOSYS and the syscall deny
  // default. AppArmor grants these operations only to the immutable bwrap.
  // No SYS_ADMIN is added to the outer container's bounding set.
  profile.syscalls.push(
    {
      names: ["clone"],
      action: "SCMP_ACT_ALLOW",
      args: [{ index: 0, value: 0x02000000, valueTwo: 0, op: "SCMP_CMP_MASKED_EQ" }],
      includes: { arches: ["amd64"] },
    },
    {
      names: ["unshare"],
      action: "SCMP_ACT_ALLOW",
      args: [{ index: 0, value: 0x83fdffff, valueTwo: 0, op: "SCMP_CMP_MASKED_EQ" }],
    },
    { names: ["mount", "umount2", "pivot_root"], action: "SCMP_ACT_ALLOW" },
  );
  return profile;
}

// These are the immutable Docker 29.4.2 AppArmor filesystem restrictions.
// Source: moby/moby@d3298094ac5111e5d67517a252d291d27543e408,
// vendor/github.com/moby/profiles/apparmor/template.go.
const filesystemRules = `
  deny /proc/* w,
  deny /proc/{[^1-9],[^1-9][^0-9],[^1-9s][^0-9y][^0-9s],[^1-9][^0-9][^0-9][^0-9/]*}/** w,
  deny /proc/sys/[^k]** w,
  deny /proc/sys/kernel/{?,??,[^s][^h][^m]**} w,
  deny /proc/sysrq-trigger rwklx,
  deny /proc/kcore rwklx,
  deny /sys/[^f]*/** wklx,
  deny /sys/f[^s]*/** wklx,
  deny /sys/fs/[^c]*/** wklx,
  deny /sys/fs/c[^g]*/** wklx,
  deny /sys/fs/cg[^r]*/** wklx,
  deny /sys/firmware/** rwklx,
  deny /sys/devices/virtual/powercap/** rwklx,
  deny /sys/kernel/security/** rwklx,
`;
export function createAppArmor(name: string, paths: ProfilePaths): string {
  safeProfileName(name);
  const root = safePath(paths.root);
  const node = safePath(paths.nodeHome);
  const go = safePath(paths.goHome);
  const helper = join(root, "review-router-assets/codex-runtime/codex-resources/bwrap");
  const cli = join(root, "review-router-assets/codex-runtime/bin/codex");
  const peers = `{${name},${name}-bwrap,${name}-payload,${name}-bwrap//&${name}-payload}`;
  const common = `
  network,
  capability,
  signal (receive) peer=unconfined,
  signal (receive) peer=runc,
  signal (receive) peer=crun,
  signal (receive) peer=dockerd,
  signal (send,receive) peer=${peers},
  ptrace (read,readby) peer=${peers},
  deny ptrace (trace,tracedby),
${filesystemRules}`;
  // All executable roots are fixed trusted runtime paths. There is no broad
  // execute grant overlapping the sole namespace-capable helper transition.
  const execute = [
    "/usr/**",
    "/bin/**",
    "/sbin/**",
    "/lib/**",
    "/lib64/**",
    "/tmp/**",
    node + "/**",
    go + "/**",
    root + "/clients/**",
    root + "/build/execution-probe",
    cli,
  ];
  assert.ok(!execute.some((value) => helper.startsWith(value.replace(/\*\*$/, ""))));
  return `abi <abi/5.0>,
profile ${name} flags=(attach_disconnected,mediate_deleted) {
${common}
  /** rwmkl,
${execute.map((path) => "  " + path + " ix,").join("\n")}
  ${helper} px -> ${name}-bwrap,
  deny userns,
  deny mount,
  deny umount,
  deny pivot_root,
}
profile ${name}-bwrap flags=(attach_disconnected,mediate_deleted) {
${common}
  # The pinned helper opens / read-only before its second pivot. /** excludes /.
  / r,
  /** rwmkl,
  userns,
  mount,
  umount,
  pivot_root,
  # Resolve the full composite label directly. Both profiles must exist and
  # there is no inherit/unconfined fallback if either target is absent.
  # Retaining the helper in the composite permits this restriction under NNP.
  /** px -> ${name}-bwrap//&${name}-payload,
}
profile ${name}-payload flags=(attach_disconnected,mediate_deleted) {
${common}
  file,
  deny userns,
  deny mount,
  deny umount,
  deny pivot_root,
  deny capability sys_admin,
}
`;
}

export interface BindMount {
  readonly source: string;
  readonly target: string;
  readonly readonly: boolean;
}
export interface ContainerContract {
  readonly name: string;
  readonly image: string;
  readonly seccomp: string;
  readonly mounts: readonly BindMount[];
}
type ContainerInspectionField =
  | "shape"
  | "name"
  | "image"
  | "privileged"
  | "network"
  | "pid"
  | "ipc"
  | "cpu"
  | "memory"
  | "pids"
  | "user"
  | "cap-drop"
  | "cap-add"
  | "apparmor"
  | "security-options"
  | "seccomp"
  | "ulimits"
  | "devices"
  | "device-requests"
  | "mount-count"
  | "mount-target"
  | "mount-source"
  | "mount-readonly"
  | "mount-propagation"
  | "volume-count"
  | "volume-target"
  | "volume-readonly"
  | "volume-name"
  | "mount-types";
export class ContainerInspectionError extends Error {
  readonly field: ContainerInspectionField;
  constructor(field: ContainerInspectionField) {
    super("container-inspection:" + field);
    this.field = field;
  }
}
export function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
export function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}
function strings(value: unknown): string[] {
  const values = array(value);
  assert.ok(values.every((entry) => typeof entry === "string"));
  return values;
}
export function anonymousVolumeNames(actual: unknown): string[] {
  return array(object(actual).Mounts)
    .map(object)
    .filter((mount) => mount.Type === "volume")
    .map((mount) => {
      assert.equal(typeof mount.Name, "string");
      assert.match(String(mount.Name), /^[a-f0-9]{64}$/);
      return String(mount.Name);
    });
}
export function requireContainer(actual: unknown, expected: ContainerContract): void {
  let field: ContainerInspectionField = "shape";
  try {
    const data = object(actual),
      host = object(data.HostConfig),
      config = object(data.Config);
    field = "name";
    assert.equal(data.Name, "/" + safeProfileName(expected.name));
    field = "image";
    assert.equal(data.Image, expected.image);
    field = "privileged";
    assert.equal(host.Privileged, false);
    field = "network";
    assert.equal(host.NetworkMode, "none");
    field = "pid";
    assert.equal(host.PidMode, "");
    field = "ipc";
    assert.equal(host.IpcMode, "private");
    field = "cpu";
    assert.equal(host.NanoCpus, 2_000_000_000);
    field = "memory";
    assert.equal(host.Memory, 4 * 1024 ** 3);
    field = "pids";
    assert.equal(host.PidsLimit, 256);
    field = "user";
    assert.equal(config.User, "0:0");
    field = "cap-drop";
    assert.deepEqual(host.CapDrop, ["ALL"]);
    field = "cap-add";
    // Docker CLI's vendored client canonicalizes these names before create.
    assert.deepEqual(
      strings(host.CapAdd).toSorted(),
      capabilities.map((capability) => "CAP_" + capability).toSorted(),
    );
    field = "apparmor";
    assert.equal(data.AppArmorProfile, expected.name);
    field = "security-options";
    const security = strings(host.SecurityOpt);
    assert.equal(security.length, 2);
    assert.ok(security.includes("apparmor=" + expected.name));
    // Docker inspect expands seccomp paths into the actual JSON filter.
    field = "seccomp";
    const seccomp = security.find((value) => value.startsWith("seccomp="));
    assert.ok(seccomp !== undefined);
    assert.deepEqual(
      JSON.parse(seccomp.slice(8)),
      JSON.parse(readFileSync(expected.seccomp, "utf8")),
    );
    field = "ulimits";
    assert.deepEqual(host.Ulimits, [{ Name: "nofile", Hard: 4096, Soft: 4096 }]);
    field = "devices";
    assert.deepEqual(host.Devices, []);
    field = "device-requests";
    assert.deepEqual(host.DeviceRequests ?? [], []);
    field = "mount-count";
    const mounts = array(data.Mounts).map(object);
    const bindings = mounts.filter((value) => value.Type === "bind");
    assert.equal(bindings.length, expected.mounts.length);
    for (const mount of expected.mounts) {
      field = "mount-target";
      const observed = bindings.find((value) => value.Destination === mount.target);
      assert.ok(observed);
      field = "mount-source";
      assert.equal(observed.Source, mount.source);
      field = "mount-readonly";
      assert.equal(observed.RW, !mount.readonly);
      field = "mount-propagation";
      assert.equal(observed.Propagation, "rprivate");
    }
    // PostgreSQL 17 declares this anonymous volume even with a custom entrypoint.
    field = "volume-count";
    const volumes = mounts.filter((value) => value.Type === "volume");
    assert.equal(volumes.length, 1);
    field = "volume-target";
    assert.equal(volumes[0]?.Destination, "/var/lib/postgresql/data");
    field = "volume-readonly";
    assert.equal(volumes[0]?.RW, true);
    field = "volume-name";
    assert.match(String(volumes[0]?.Name), /^[a-f0-9]{64}$/);
    field = "mount-types";
    assert.equal(mounts.length, bindings.length + volumes.length);
  } catch {
    // Never retain raw inspection values, environment or assertion diffs.
    throw new ContainerInspectionError(field);
  }
}
