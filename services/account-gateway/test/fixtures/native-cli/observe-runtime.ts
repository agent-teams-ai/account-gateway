// Test-branch observation only: no sandbox, provider, PostgreSQL or namespace probe.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const baseImage =
  "postgres:17.10@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317";
const runtimeImage = "gateway-native-clients:qualified";
type Kind =
  | "bit"
  | "integer"
  | "seccomp"
  | "capabilities"
  | "apparmor"
  | "profile"
  | "version"
  | "digest"
  | "imageOS"
  | "imageVersion";
type Value = { state: "observed"; value: string | number | boolean };
type Missing = { state: "missing" | "denied" | "unavailable" | "unrecognized" };

export function scalar(kind: Kind, raw: unknown): Value | Missing {
  if (raw === undefined) return { state: "unavailable" };
  if (typeof raw !== "string" || raw.length > 256) return { state: "unrecognized" };
  const value = raw.trim();
  if (
    (kind === "bit" && /^[01]$/.test(value)) ||
    (kind === "seccomp" && /^[012]$/.test(value)) ||
    (kind === "integer" && /^(0|[1-9][0-9]{0,9})$/.test(value))
  ) {
    return { state: "observed", value: Number(value) };
  }
  if (kind === "apparmor" && /^[YN]$/.test(value))
    return { state: "observed", value: value === "Y" };
  if (kind === "profile") {
    const profiles: Readonly<Record<string, string>> = {
      unconfined: "unconfined",
      "docker-default (enforce)": "docker_default_enforce",
      "docker-default (complain)": "docker_default_complain",
    };
    if (Object.hasOwn(profiles, value)) return { state: "observed", value: profiles[value]! };
  }
  const patterns: Partial<Record<Kind, RegExp>> = {
    capabilities: /^[0-9a-f]{16}$/,
    version: /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/,
    digest: /^sha256:[0-9a-f]{64}$/,
    imageOS: /^ubuntu(?:20|22|24|26)$/,
    imageVersion: /^[0-9]{8}\.[0-9]{1,4}\.[0-9]{1,4}$/,
  };
  return patterns[kind]?.test(value) ? { state: "observed", value } : { state: "unrecognized" };
}

export function securityOptions(raw: unknown) {
  if (raw === undefined) return { state: "unavailable" };
  if (
    !Array.isArray(raw) ||
    raw.length > 16 ||
    raw.some((item) => typeof item !== "string" || item.length > 256)
  ) {
    return { state: "unrecognized" };
  }
  const known: Readonly<Record<string, string>> = {
    "name=apparmor": "apparmor",
    "name=selinux": "selinux",
    "name=seccomp,profile=builtin": "seccomp_builtin",
    "name=cgroupns": "cgroup_namespace",
    "name=rootless": "rootless",
    "name=no-new-privileges": "no_new_privileges",
  };
  return {
    state: "observed",
    values: [
      ...new Set(raw.flatMap((item: string) => (Object.hasOwn(known, item) ? [known[item]!] : []))),
    ].sort(),
    unknownCount: raw.filter((item: string) => !Object.hasOwn(known, item)).length,
  };
}

function read(path: string, kind: Kind, field?: string): Value | Missing {
  try {
    let text = readFileSync(path, "utf8");
    if (text.length > 65_536) return { state: "unrecognized" };
    if (field) {
      const lines = text.split("\n").filter((line) => line.startsWith(field + ":"));
      if (lines.length !== 1) return { state: "unrecognized" };
      text = lines[0]!.slice(field.length + 1);
    }
    return scalar(kind, text);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      state:
        code === "ENOENT" || code === "ENOTDIR"
          ? "missing"
          : code === "EACCES" || code === "EPERM"
            ? "denied"
            : "unavailable",
    };
  }
}

// Only fixed metadata commands; no supplied command/path, daemon mutation or stderr export.
function docker(args: readonly string[]): unknown {
  const result = spawnSync("docker", [...args], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 65_536,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    return undefined;
  }
}

function main() {
  const phase = process.argv[2];
  if (
    process.argv.length !== 3 ||
    (phase !== "host" && phase !== "container") ||
    !/^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA ?? "")
  ) {
    throw new Error("runtime-observation-input-invalid");
  }
  const receipt = {
    kind: "native-runtime-environment-observation/v1",
    qualification: "not_evaluated",
    sourceCommit: process.env.GITHUB_SHA,
    phase,
    baseImage,
    runtimeImage,
    processStatus: {
      effectiveCapabilities: read("/proc/self/status", "capabilities", "CapEff"),
      noNewPrivileges: read("/proc/self/status", "bit", "NoNewPrivs"),
      seccomp: read("/proc/self/status", "seccomp", "Seccomp"),
      seccompFilters: read("/proc/self/status", "integer", "Seccomp_filters"),
      apparmorProfile: read("/proc/self/attr/current", "profile"),
    },
    namespaceConfiguration: {
      unprivilegedUserNamespaces: read("/proc/sys/kernel/unprivileged_userns_clone", "bit"),
      maximumUserNamespaces: read("/proc/sys/user/max_user_namespaces", "integer"),
      apparmorRestrictsUnprivilegedUserNamespaces: read(
        "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
        "bit",
      ),
      apparmorEnabled: read("/sys/module/apparmor/parameters/enabled", "apparmor"),
    },
    ...(phase === "host"
      ? {
          runnerImage: {
            os: scalar("imageOS", process.env.ImageOS),
            version: scalar("imageVersion", process.env.ImageVersion),
          },
          docker: {
            version: scalar("version", docker(["version", "--format", "{{json .Server.Version}}"])),
            securityOptions: securityOptions(
              docker(["info", "--format", "{{json .SecurityOptions}}"]),
            ),
            imageId: scalar(
              "digest",
              docker(["image", "inspect", "--format", "{{json .Id}}", runtimeImage]),
            ),
          },
        }
      : {}),
  };
  process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
