import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  capabilities,
  createAppArmor,
  createSeccomp,
  requireContainer,
  safePath,
  safeProfileName,
  type ContainerContract,
} from "./execution-profile.ts";
import { requireProbe } from "./execution-preflight.ts";

const name = "gateway-joined-0123456789abcdef01234567";
const profilePaths = {
  root: "/home/runner/work/_temp/gateway-native-clients",
  nodeHome: "/opt/node",
  goHome: "/opt/go",
};

void test("profile paths cannot inject policy syntax or overlap the helper execute grant", () => {
  for (const path of [
    "/",
    "/tmp/../etc",
    "/tmp/a b",
    "/tmp/a\n/** ux,",
    "/tmp/*",
    "/tmp/{a,b}",
    "/tmp//a",
    "relative",
  ]) {
    assert.throws(() => safePath(path));
  }
  for (const value of ["docker-default", name + "\nprofile x", name + "/extra"]) {
    assert.throws(() => safeProfileName(value));
  }
  assert.doesNotThrow(() => createAppArmor(name, profilePaths));
  assert.throws(() => createAppArmor(name, { ...profilePaths, root: "/tmp/overlapping" }));
  assert.throws(() => createAppArmor(name, { ...profilePaths, nodeHome: "/home/runner" }));
});

void test("seccomp keeps every pinned upstream rule and the default deny action", () => {
  const baseline = JSON.parse(
    readFileSync(new URL("./docker-seccomp-default.fixture", import.meta.url), "utf8"),
  ) as { defaultAction: string; syscalls: unknown[] };
  const generated = createSeccomp() as { defaultAction: string; syscalls: unknown[] };
  assert.equal(generated.defaultAction, "SCMP_ACT_ERRNO");
  assert.deepEqual(generated.syscalls.slice(0, baseline.syscalls.length), baseline.syscalls);
  assert.equal(generated.syscalls.length, baseline.syscalls.length + 3);
});

const match = (flags: number, mask: number) => (flags & mask) === 0;
void test("namespace seccomp additions exclude cgroup and unsupported unshare flags", () => {
  const generated = createSeccomp() as {
    syscalls: Array<{ names: string[]; args?: Array<{ value: number; valueTwo: number }> }>;
  };
  const additions = generated.syscalls.slice(-3);
  const cloneMask = additions[0].args![0].value;
  const unshareMask = additions[1].args![0].value;
  assert.equal(match(0x70020011, cloneMask), true); // user, mount, PID, network + SIGCHLD
  assert.equal(match(0x72020011, cloneMask), false); // cgroup is not needed by the pinned invocation
  for (const flags of [0x10000000, 0x00020000, 0x20000000, 0x40000000]) {
    assert.equal(match(flags, unshareMask), true);
  }
  for (const flags of [0x02000000, 0x00000100, 0x00000400, 0x00000800, 0x00000080]) {
    assert.equal(match(flags, unshareMask), false);
  }
  assert.deepEqual(additions[2].names, ["mount", "umount2", "pivot_root"]);
});

function fixture(seccomp: string) {
  const expected: ContainerContract = {
    name,
    image: "sha256:" + "1".repeat(64),
    seccomp,
    mounts: [
      { source: "/repo", target: "/repo", readonly: true },
      { source: "/artifacts", target: "/artifacts", readonly: false },
    ],
  };
  const actual = {
    Name: "/" + name,
    Image: expected.image,
    AppArmorProfile: name,
    Config: { User: "0:0" },
    HostConfig: {
      Privileged: false,
      NetworkMode: "none",
      PidMode: "",
      IpcMode: "private",
      NanoCpus: 2_000_000_000,
      Memory: 4 * 1024 ** 3,
      PidsLimit: 256,
      CapDrop: ["ALL"],
      CapAdd: [...capabilities],
      SecurityOpt: ["apparmor=" + name, "seccomp=" + readFileSync(seccomp, "utf8")],
      Ulimits: [{ Name: "nofile", Hard: 4096, Soft: 4096 }],
      Devices: [],
      DeviceRequests: [],
    },
    Mounts: [
      { Type: "bind", Source: "/repo", Destination: "/repo", RW: false, Propagation: "rprivate" },
      {
        Type: "bind",
        Source: "/artifacts",
        Destination: "/artifacts",
        RW: true,
        Propagation: "rprivate",
      },
      { Type: "volume", Destination: "/var/lib/postgresql/data", RW: true, Name: "2".repeat(64) },
    ],
  };
  return { expected, actual };
}
type Inspection = ReturnType<typeof fixture>["actual"];
const mutations: Array<[string, (value: Inspection) => void]> = [
  [
    "privileged",
    (v) => {
      v.HostConfig.Privileged = true;
    },
  ],
  [
    "host network",
    (v) => {
      v.HostConfig.NetworkMode = "host";
    },
  ],
  [
    "host PID",
    (v) => {
      v.HostConfig.PidMode = "host";
    },
  ],
  [
    "host IPC",
    (v) => {
      v.HostConfig.IpcMode = "host";
    },
  ],
  [
    "SYS_ADMIN",
    (v) => {
      v.HostConfig.CapAdd.push("SYS_ADMIN" as (typeof capabilities)[number]);
    },
  ],
  [
    "implicit capabilities",
    (v) => {
      v.HostConfig.CapDrop = [];
    },
  ],
  [
    "wrong AppArmor attachment",
    (v) => {
      v.AppArmorProfile = "docker-default";
    },
  ],
  [
    "unconfined seccomp",
    (v) => {
      v.HostConfig.SecurityOpt[1] = "seccomp=unconfined";
    },
  ],
  [
    "changed seccomp",
    (v) => {
      v.HostConfig.SecurityOpt[1] = 'seccomp={"defaultAction":"SCMP_ACT_ALLOW"}';
    },
  ],
  [
    "unbounded PIDs",
    (v) => {
      v.HostConfig.PidsLimit = 0;
    },
  ],
  [
    "unbounded memory",
    (v) => {
      v.HostConfig.Memory = 0;
    },
  ],
  [
    "writable source",
    (v) => {
      v.Mounts[0].RW = true;
    },
  ],
  [
    "changed source",
    (v) => {
      v.Mounts[0].Source = "/other";
    },
  ],
  [
    "shared propagation",
    (v) => {
      v.Mounts[0].Propagation = "rshared";
    },
  ],
  [
    "extra volume",
    (v) => {
      v.Mounts.push({ ...v.Mounts[2], Destination: "/additional" });
    },
  ],
  [
    "wrong PostgreSQL volume",
    (v) => {
      v.Mounts[2].Destination = "/etc";
    },
  ],
  [
    "named durable volume",
    (v) => {
      v.Mounts[2].Name = "production";
    },
  ],
];
for (const [label, mutate] of mutations) {
  void test("container rejects " + label, () => {
    const scratch = mkdtempSync(join(tmpdir(), "gateway-profile-contract-"));
    try {
      const seccomp = join(scratch, "seccomp.json");
      writeFileSync(seccomp, JSON.stringify(createSeccomp()));
      const { actual, expected } = fixture(seccomp);
      assert.doesNotThrow(() => {
        requireContainer(actual, expected);
      });
      mutate(actual);
      assert.throws(() => {
        requireContainer(actual, expected);
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}

void test("probe receipt requires every independent denial and exact enforced phase", () => {
  const profile = name + "-bwrap//&" + name + "-payload";
  const keys = [
    "enforcedProfile",
    "seccompFilter",
    "noInitialSysAdmin",
    "canaryRead",
    "userNamespaceDenied",
    "mountDenied",
    "immutableWriteDenied",
    "immutableModeDenied",
    "ownedChildAlive",
    "processMemoryReadDenied",
    "processMemoryWriteDenied",
    "procMemoryDenied",
    "ptraceDenied",
    "noNewPrivileges",
    "workspaceWriteDenied",
    "workspaceModeDenied",
    "outsideWriteDenied",
    "outsideModeDenied",
    "loopbackDenied",
  ];
  const receipt = {
    kind: "gateway-execution-probe/v1",
    phase: "payload",
    uid: 0,
    profile: profile + " (enforce)",
    pass: true,
    checks: Object.fromEntries(keys.map((key) => [key, true])),
  };
  const expected = { phase: "payload", uid: 0, profile };
  assert.doesNotThrow(() => requireProbe(JSON.stringify(receipt), expected));
  for (const key of keys) {
    assert.throws(() =>
      requireProbe(
        JSON.stringify({ ...receipt, checks: { ...receipt.checks, [key]: false } }),
        expected,
      ),
    );
    const checks = { ...receipt.checks };
    delete checks[key];
    assert.throws(() => requireProbe(JSON.stringify({ ...receipt, checks }), expected));
  }
  assert.throws(() => requireProbe(JSON.stringify({ ...receipt, pass: false }), expected));
  assert.throws(() =>
    requireProbe(JSON.stringify({ ...receipt, profile: profile + " (complain)" }), expected),
  );
  assert.throws(() => requireProbe(JSON.stringify({ ...receipt, uid: 65534 }), expected));
  assert.throws(() => requireProbe(JSON.stringify({ ...receipt, phase: "outer" }), expected));
  assert.throws(() =>
    requireProbe(
      JSON.stringify({ ...receipt, checks: { ...receipt.checks, unexpected: true } }),
      expected,
    ),
  );
});
