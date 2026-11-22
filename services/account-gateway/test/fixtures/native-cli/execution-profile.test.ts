import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ContainerInspectionError,
  createAppArmor,
  createSeccomp,
  requireContainer,
  safePath,
  safeProfileName,
  type ContainerContract,
} from "./execution-profile.ts";
import {
  parsePIDPressure,
  ProbeReportError,
  requireProbe,
  requireReaping,
} from "./execution-preflight.ts";
import { payloadCommandFailure } from "./execution-diagnostics.ts";
import { command, CommandFailure } from "./joined-command.ts";

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
      Init: true,
      NetworkMode: "none",
      PidMode: "",
      IpcMode: "private",
      NanoCpus: 2_000_000_000,
      Memory: 4 * 1024 ** 3,
      PidsLimit: 256,
      CapDrop: ["ALL"],
      // Literal Docker CLI inspect representation, independent of our builder.
      CapAdd: [
        "CAP_AUDIT_WRITE",
        "CAP_CHOWN",
        "CAP_DAC_OVERRIDE",
        "CAP_FOWNER",
        "CAP_FSETID",
        "CAP_KILL",
        "CAP_MKNOD",
        "CAP_NET_BIND_SERVICE",
        "CAP_NET_RAW",
        "CAP_SETFCAP",
        "CAP_SETGID",
        "CAP_SETPCAP",
        "CAP_SETUID",
        "CAP_SYS_CHROOT",
      ],
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
void test("container requires an explicitly enabled init process", () => {
  const scratch = mkdtempSync(join(tmpdir(), "gateway-profile-init-"));
  try {
    const seccomp = join(scratch, "seccomp.json");
    writeFileSync(seccomp, JSON.stringify(createSeccomp()));
    for (const init of [false, undefined, null, "true", 1]) {
      const { actual, expected } = fixture(seccomp);
      assert.doesNotThrow(() => {
        requireContainer(actual, expected);
      });
      const host: Record<string, unknown> = actual.HostConfig;
      if (init === undefined) {
        delete host.Init;
      } else {
        host.Init = init;
      }
      assert.throws(
        () => {
          requireContainer(actual, expected);
        },
        (error: unknown) =>
          error instanceof ContainerInspectionError &&
          error.message === "container-inspection:init",
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
const mutations: Array<[string, (value: Inspection) => void, ContainerInspectionError["field"]]> = [
  [
    "privileged",
    (v) => {
      v.HostConfig.Privileged = true;
    },
    "privileged",
  ],
  [
    "host network",
    (v) => {
      v.HostConfig.NetworkMode = "host";
    },
    "network",
  ],
  [
    "host PID",
    (v) => {
      v.HostConfig.PidMode = "host";
    },
    "pid",
  ],
  [
    "host IPC",
    (v) => {
      v.HostConfig.IpcMode = "host";
    },
    "ipc",
  ],
  [
    "SYS_ADMIN",
    (v) => {
      v.HostConfig.CapAdd.push("CAP_SYS_ADMIN");
    },
    "cap-add",
  ],
  [
    "implicit capabilities",
    (v) => {
      v.HostConfig.CapDrop = [];
    },
    "cap-drop",
  ],
  [
    "wrong AppArmor attachment",
    (v) => {
      v.AppArmorProfile = "docker-default";
    },
    "apparmor",
  ],
  [
    "unconfined seccomp",
    (v) => {
      v.HostConfig.SecurityOpt[1] = "seccomp=unconfined";
    },
    "seccomp",
  ],
  [
    "changed seccomp",
    (v) => {
      v.HostConfig.SecurityOpt[1] = 'seccomp={"defaultAction":"SCMP_ACT_ALLOW"}';
    },
    "seccomp",
  ],
  [
    "unbounded PIDs",
    (v) => {
      v.HostConfig.PidsLimit = 0;
    },
    "pids",
  ],
  [
    "unbounded memory",
    (v) => {
      v.HostConfig.Memory = 0;
    },
    "memory",
  ],
  [
    "writable source",
    (v) => {
      v.Mounts[0].RW = true;
    },
    "mount-readonly",
  ],
  [
    "changed source",
    (v) => {
      v.Mounts[0].Source = "/other";
    },
    "mount-source",
  ],
  [
    "shared propagation",
    (v) => {
      v.Mounts[0].Propagation = "rshared";
    },
    "mount-propagation",
  ],
  [
    "extra volume",
    (v) => {
      v.Mounts.push({ ...v.Mounts[2], Destination: "/additional" });
    },
    "volume-count",
  ],
  [
    "wrong PostgreSQL volume",
    (v) => {
      v.Mounts[2].Destination = "/etc";
    },
    "volume-target",
  ],
  [
    "named durable volume",
    (v) => {
      v.Mounts[2].Name = "production";
    },
    "volume-name",
  ],
];
for (const [label, mutate, field] of mutations) {
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
      assert.throws(
        () => {
          requireContainer(actual, expected);
        },
        (error: unknown) => {
          assert.ok(error instanceof ContainerInspectionError);
          assert.equal(error.field, field);
          assert.equal(error.message, "container-inspection:" + field);
          return true;
        },
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}

void test("owned orphan proof rejects a retained zombie or a different adopting parent", () => {
  const receipt = {
    kind: "gateway-execution-reaping-probe/v1",
    checks: {
      initPID1: true,
      initReadOnly: true,
      ownedOrphanStarted: true,
      ownedOrphanAdopted: true,
      ownedOrphanReaped: true,
    },
    pass: true,
  };
  assert.deepEqual(requireReaping(JSON.stringify(receipt)), receipt);
  for (const key of Object.keys(receipt.checks)) {
    const failed = { ...receipt, checks: { ...receipt.checks, [key]: false } };
    // Neither a claimed PASS nor an honestly failed probe can qualify.
    assert.throws(() => requireReaping(JSON.stringify(failed)), ProbeReportError);
    assert.throws(
      () => requireReaping(JSON.stringify({ ...failed, pass: false })),
      ProbeReportError,
    );
  }
  for (const changed of [
    { ...receipt, checks: { ...receipt.checks, pid: 1 } },
    { ...receipt, checks: { ...receipt.checks, ownedOrphanReaped: "true" } },
    { ...receipt, kind: "unrelated-probe" },
    { ...receipt, command: "PRIVATE_COMMAND" },
  ]) {
    assert.throws(() => requireReaping(JSON.stringify(changed)), ProbeReportError);
  }
});

void test("PID pressure stays numeric and preserves exhaustion evidence and absent peak", () => {
  assert.deepEqual(parsePIDPressure("19\n", "256\n", "max 4\n", "256\n"), {
    current: 19,
    max: 256,
    eventsMax: 4,
    peak: 256,
  });
  assert.deepEqual(parsePIDPressure("12", "256", "max 0", null), {
    current: 12,
    max: 256,
    eventsMax: 0,
    peak: null,
  });
  for (const args of [
    ["PRIVATE_DATA", "256", "max 0", null],
    ["12", "max", "max 0", null],
    ["12", "512", "max 0", null],
    ["12", "256", "max 0\nother 1", null],
    ["12", "256", "max -1", null],
    ["12", "256", "max 0", "9007199254740992"],
  ] as const) {
    assert.throws(
      () => parsePIDPressure(args[0], args[1], args[2], args[3]),
      (error: unknown) => {
        assert.ok(error instanceof ProbeReportError);
        assert.equal(error.message, "execution-probe-report:pids");
        assert.equal(JSON.stringify(error).includes("PRIVATE"), false);
        return true;
      },
    );
  }
});

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
    procMemory: { pidNumbersMatch: true, readOpen: "eacces", readWriteOpen: "eperm" },
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
  for (const pidNumbersMatch of [true, false]) {
    assert.doesNotThrow(() =>
      requireProbe(
        JSON.stringify({
          ...receipt,
          procMemory: { pidNumbersMatch, readOpen: "eacces", readWriteOpen: "erofs" },
        }),
        expected,
      ),
    );
  }
  // A read-only filesystem cannot substitute for an independent read denial.
  for (const [readOpen, readWriteOpen] of [
    ["opened", "eperm"],
    ["erofs", "erofs"],
    ["other", "eperm"],
    ["eacces", "opened"],
    ["eperm", "other"],
  ]) {
    assert.throws(() =>
      requireProbe(
        JSON.stringify({
          ...receipt,
          procMemory: { pidNumbersMatch: true, readOpen, readWriteOpen },
        }),
        expected,
      ),
    );
  }
  assert.throws(() =>
    requireProbe(
      JSON.stringify({ ...receipt, checks: { ...receipt.checks, unexpected: true } }),
      expected,
    ),
  );
  for (const [raw, field] of [
    ["", "empty"],
    ["PRIVATE_DIAGNOSTIC", "json"],
    [JSON.stringify({ ...receipt, profile: "PRIVATE_PROFILE" }), "profile"],
    [
      JSON.stringify({
        ...receipt,
        procMemory: { ...receipt.procMemory, readOpen: "PRIVATE_ERROR" },
      }),
      "proc-memory",
    ],
    [
      JSON.stringify({ ...receipt, procMemory: { ...receipt.procMemory, path: "PRIVATE_PATH" } }),
      "proc-memory",
    ],
  ]) {
    assert.throws(
      () => requireProbe(raw, expected),
      (error: unknown) => {
        assert.ok(error instanceof ProbeReportError);
        assert.equal(error.field, field);
        assert.equal(error.message, "execution-probe-report:" + field);
        assert.equal(JSON.stringify(error).includes("PRIVATE"), false);
        return true;
      },
    );
  }
});

void test("failed payload keeps stdout separate and exports only closed command diagnostics", async () => {
  const child = fileURLToPath(new URL("./joined-command-fixture.ts", import.meta.url));
  const cases: Array<[string, string, string | readonly string[] | null, number | null]> = [
    [
      "bwrap: Creating new namespace failed: PRIVATE_ERROR\n",
      "namespace-refused",
      "bubblewrap.c:3162",
      null,
    ],
    [
      "bwrap: Creating new namespace failed: nesting depth or /proc/sys/user/max_*_namespaces exceeded (ENOSPC)\n",
      "namespace-refused",
      "bubblewrap.c:3160",
      28,
    ],
    [
      "bwrap: Creating new namespace failed: nesting depth or /proc/sys/user/max_*_namespaces exceeded (ENOSPC) PRIVATE_SUFFIX\n",
      "namespace-refused",
      "bubblewrap.c:3160",
      null,
    ],
    ["bwrap: setting up uid map: PRIVATE_ERROR\n", "uid-gid-map", "bubblewrap.c:1011", null],
    ["bwrap: setting up gid map: PRIVATE_ERROR\n", "uid-gid-map", "bubblewrap.c:1026", null],
    [
      "bwrap: error writing to setgroups: PRIVATE_ERROR\n",
      "uid-gid-map",
      "bubblewrap.c:1022",
      null,
    ],
    ["bwrap: pivot_root(/newroot): Permission denied\n", "mount-refused", "bubblewrap.c:3460", 13],
    ["bwrap: umount old root: Operation not permitted\n", "mount-refused", "bubblewrap.c:3464", 1],
    [
      "bwrap: Can't bind mount /PRIVATE_SOURCE on /PRIVATE_DEST: Permission denied\n",
      "mount-refused",
      "bubblewrap.c:1129",
      13,
    ],
    ["bwrap: setsid: Operation not permitted\n", "helper-setup", "bubblewrap.c:3565", 1],
    [
      "bwrap: prctl(PR_SET_NO_NEW_PRIVS) failed: Invalid argument\n",
      "helper-setup",
      "bubblewrap.c:2934",
      22,
    ],
    [
      "WARNING: proceeding, even though we could not update PATH: PRIVATE_PATH\nRefusing to create helper binaries under temporary dir PRIVATE_PATH\n<3>bwrap: Can't chdir to /PRIVATE_PATH: Permission denied\nbwrap: setsid: Operation not permitted\n",
      "helper-setup",
      "bubblewrap.c:3544",
      13,
    ],
    [
      "WARNING: failed to prepare host proxy routing bridge: PRIVATE_WARNING\nfailed to prepare host proxy routing bridge: PRIVATE_DETAIL (os error 13)\n",
      "codex-diagnostic",
      "linux_run_main.rs:220",
      13,
    ],
    [
      "Error: Failed to read config file /PRIVATE_CONFIG: Permission denied (os error 13)\n",
      "codex-diagnostic",
      "config/src/loader/mod.rs:472",
      13,
    ],
    [
      "Error: Permission denied (os error 13)\nStack backtrace:\n0: PRIVATE_ADDRESS <unknown>\n",
      "generic-os-error",
      null,
      13,
    ],
    ["Error: PRIVATE_ERROR (os error 999)\n", "cli-unclassified", null, null],
    ["Error: PRIVATE_ERROR: Permission denied\n", "cli-unclassified", null, null],
    [
      "<4>bwrap: Can't chdir to /PRIVATE_WARNING: Permission denied\nPRIVATE_STDERR\n",
      "unclassified-exit",
      null,
      null,
    ],
    [
      "bwrap: open /proc/PRIVATE_PID/ns failed: Permission denied\n",
      "helper-setup",
      ["bubblewrap.c:991", "bubblewrap.c:2840"],
      13,
    ],
    [
      "bwrap: capset failed: Operation not permitted\n",
      "helper-setup",
      ["bubblewrap.c:703", "bubblewrap.c:742"],
      1,
    ],
    ["bubblewrap is unavailable: PRIVATE_DETAILS\n", "helper-unavailable", "launcher.rs:43", null],
    [
      "bundled bubblewrap digest mismatch for /PRIVATE_BINARY: expected sha256:PRIVATE_EXPECTED, got sha256:PRIVATE_ACTUAL\n",
      "helper-digest",
      "bundled_bwrap.rs:154",
      null,
    ],
    ["PRIVATE_STDERR\n", "unclassified-exit", null, null],
  ];
  for (const [stderr, reason, site, errno] of cases) {
    await assert.rejects(
      command(process.execPath, [child, "failure", "PRIVATE_STDOUT\n", stderr], {}),
      (error: unknown) => {
        assert.ok(error instanceof CommandFailure);
        assert.equal(error.stdout, "PRIVATE_STDOUT\n");
        assert.equal(error.stderr, stderr);
        assert.deepEqual(payloadCommandFailure(error), {
          exitCode: 1,
          signal: null,
          timedOut: false,
          outputLimit: false,
          reason,
          sites: site === null ? [] : typeof site === "string" ? [site] : site,
          errno,
        });
        assert.equal(JSON.stringify(payloadCommandFailure(error)).includes("PRIVATE"), false);
        return true;
      },
    );
  }
  assert.deepEqual(payloadCommandFailure(new Error("PRIVATE_SPAWN_ERROR")), {
    reason: "spawn-or-command",
  });
});
