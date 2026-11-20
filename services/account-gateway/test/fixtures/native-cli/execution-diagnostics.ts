// Closed fatal diagnostics for the already pinned Codex 0.133.0 binaries.
// Source: openai/codex@rust-v0.133.0, codex-rs/vendor/bubblewrap/{bubblewrap.c,
// bind-mount.c,utils.c}, linux-sandbox/src/{linux_run_main,launcher,bundled_bwrap,
// exec_util}.rs and the startup paths named below. Every retained fixed prefix
// occurs in the exact digest-verified shipped binary; conditionally compiled
// source-only messages are excluded. Each candidate-site group includes all
// listed source literals sharing that prefix, even when their interpolated
// suffixes differ. These groups identify observed prefixes, never a stack trace.
// Only constant candidate-site IDs and closed errno values are exported.
import { CommandFailure } from "./joined-command.ts";
import { constants } from "node:os";

const bwrapSites = [
  [
    ["bubblewrap.c:3156"],
    "No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces. On e.g. debian this can be enabled with 'sysctl kernel.unprivileged_userns_clone=1'.",
  ],
  [
    ["bubblewrap.c:296"],
    "Unable to set up system call filtering as requested: prctl(PR_SET_SECCOMP) reported EINVAL. (Hint: this requires a kernel configured with CONFIG_SECCOMP and CONFIG_SECCOMP_FILTER.)",
  ],
  [
    ["bubblewrap.c:3154"],
    "Creating new namespace failed, likely because the kernel does not support user namespaces.  bwrap must be installed setuid on such systems.",
  ],
  [
    ["bubblewrap.c:2784", "bubblewrap.c:2803"],
    "--overlay-src must be followed by another --overlay-src or one of --overlay, --tmp-overlay, or --ro-overlay",
  ],
  [
    ["bubblewrap.c:3136"],
    "Joining the specified user namespace failed, it might not be a descendant of the current user namespace.",
  ],
  [
    ["bubblewrap.c:3160"],
    "Creating new namespace failed: nesting depth or /proc/sys/user/max_*_namespaces exceeded (ENOSPC)",
  ],
  [
    ["bubblewrap.c:3106"],
    "Cannot create new cgroup namespace because the kernel does not support it",
  ],
  [["bubblewrap.c:3518"], "creation of new user namespaces was not disabled as requested"],
  [["bubblewrap.c:894"], "Unexpected capabilities but not setuid, old file caps config?"],
  [["bubblewrap.c:2977"], "--disable-userns is not compatible with  --userns-block-fd"],
  [["bubblewrap.c:2776"], "--perms must be followed by an option that creates a file"],
  [["bubblewrap.c:886"], "setuid use of bubblewrap is not supported in this build"],
  [["bubblewrap.c:3062"], "Specifying --as-pid-1 and --lock-file is not permitted"],
  [["bubblewrap.c:3050"], "Specifying --uid requires --unshare-user or --userns"],
  [["bubblewrap.c:3053"], "Specifying --gid requires --unshare-user or --userns"],
  [["bubblewrap.c:2433"], "--seccomp cannot be combined with --add-seccomp-fd"],
  [["bubblewrap.c:2456"], "--add-seccomp-fd cannot be combined with --seccomp"],
  [["bubblewrap.c:2085"], "--tmp-overlay requires at least one --overlay-src"],
  [["bubblewrap.c:2104"], "--ro-overlay requires at least two --overlay-src"],
  [["bubblewrap.c:1190"], "Refusing to set hostname in original namespace"],
  [["bubblewrap.c:3495"], "cannot open /proc/sys/user/max_user_namespaces"],
  [["bubblewrap.c:2064"], "--overlay requires at least one --overlay-src"],
  [["bubblewrap.c:3056"], "Specifying --hostname requires --unshare-uts"],
  [["bubblewrap.c:3059"], "Specifying --as-pid-1 requires --unshare-pid"],
  [["bubblewrap.c:279"], "Invalid seccomp data, must be multiple of 8"],
  [["bubblewrap.c:2971"], "--userns not compatible --unshare-user-try"],
  [["bubblewrap.c:2962"], "--userns-block-fd requires --unshare-user"],
  [["bubblewrap.c:2690"], "--perms takes an octal argument <= 07777"],
  [["bubblewrap.c:2747"], "--chmod takes an octal argument <= 07777"],
  [["bubblewrap.c:2818"], "Can't parse /proc/sys/kernel/overflowuid"],
  [["bubblewrap.c:2826"], "Can't parse /proc/sys/kernel/overflowgid"],
  [["bubblewrap.c:2974"], "--disable-userns requires --unshare-user"],
  [["bubblewrap.c:2682"], "--perms given twice for the same action"],
  [["bubblewrap.c:2723"], "--size takes a non-zero number of bytes"],
  [["bubblewrap.c:2814"], "Can't read /proc/sys/kernel/overflowuid"],
  [["bubblewrap.c:2822"], "Can't read /proc/sys/kernel/overflowgid"],
  [["bubblewrap.c:3137"], "Joining specified user namespace failed"],
  [["bubblewrap.c:1826"], "--args not supported in arguments file"],
  [["bubblewrap.c:2709"], "--size given twice for the same action"],
  [["bubblewrap.c:2968"], "--userns not compatible --unshare-user"],
  [["bubblewrap.c:3362"], "Creating --tmp-overlay upperdir failed"],
  [["utils.c:851"], "Symbolic link target pathname too long"],
  [["bubblewrap.c:1800", "bubblewrap.c:1852"], "Exceeded maximum number of arguments "],
  [["bubblewrap.c:3366"], "Creating --tmp-overlay workdir failed"],
  [["utils.c:122"], "labeling not supported on this system"],
  [["utils.c:796"], "Can't create intermediate pids socket"],
  [["utils.c:821"], "Unexpected short read from pid socket"],
  [["bubblewrap.c:2965"], "--userns-block-fd requires --info-fd"],
  [["bubblewrap.c:2370"], "--userns-block-fd takes an argument"],
  [["bubblewrap.c:3108"], "stat on /proc/self/ns/cgroup failed"],
  [["bubblewrap.c:3498"], "sysctl user.max_user_namespaces = 1"],
  [["bubblewrap.c:2280"], "--ro-bind-data takes two arguments"],
  [["bubblewrap.c:2410"], "--json-status-fd takes an argument"],
  [["bubblewrap.c:2453"], "--add-seccomp-fd takes an argument"],
  [["bubblewrap.c:2780"], "--size must be followed by --tmpfs"],
  [["bubblewrap.c:2726"], "--size (for tmpfs) is limited to "],
  [["bubblewrap.c:2934"], "prctl(PR_SET_NO_NEW_PRIVS) failed"],
  [["bubblewrap.c:1146"], "Specified tmpfs size too large ("],
  [["bubblewrap.c:3433"], "Failed to make old root rprivate"],
  [["bind-mount.c:247"], "Can't open /proc/self/mountinfo"],
  [["bubblewrap.c:1966"], "--remount-ro takes one argument"],
  [["bubblewrap.c:2061"], "--overlay takes three arguments"],
  [["bubblewrap.c:2082"], "--tmp-overlay takes an argument"],
  [["bubblewrap.c:2252"], "--bind-data takes two arguments"],
  [["bubblewrap.c:2101"], "--ro-overlay takes an argument"],
  [["bubblewrap.c:2127"], "--exec-label takes an argument"],
  [["bubblewrap.c:2141"], "--file-label takes an argument"],
  [["bubblewrap.c:2026"], "--bind-fd takes two arguments"],
  [["bubblewrap.c:2305"], "--symlink takes two arguments"],
  [["bubblewrap.c:2317"], "--lock-file takes an argument"],
  [["bubblewrap.c:3162"], "Creating new namespace failed"],
  [["bubblewrap.c:1178", "bubblewrap.c:1181"], "Can't make overlay mount on "],
  [["bubblewrap.c:1291"], "Race condition binding dirfd"],
  [["bubblewrap.c:2350"], "--block-fd takes an argument"],
  [["bubblewrap.c:2535"], "--setenv takes two arguments"],
  [["bubblewrap.c:2545"], "--unsetenv takes an argument"],
  [["bubblewrap.c:2595"], "--hostname takes an argument"],
  [["bubblewrap.c:2651"], "--cap-drop takes an argument"],
  [["bubblewrap.c:906"], "capget (for uid == 0) failed"],
  [["bubblewrap.c:1884"], "--argv0 used multiple times"],
  [["bubblewrap.c:2330"], "--sync-fd takes an argument"],
  [["bubblewrap.c:2390"], "--info-fd takes an argument"],
  [["bubblewrap.c:2430"], "--seccomp takes an argument"],
  [["bubblewrap.c:2494"], "--userns2 takes an argument"],
  [["bubblewrap.c:2625"], "--cap-add takes an argument"],
  [["bubblewrap.c:2739"], "--chmod takes two arguments"],
  [["bind-mount.c:281"], "Can't parse mountinfo line"],
  [["bubblewrap.c:1022"], "error writing to setgroups"],
  [["bubblewrap.c:1117"], "Can't remount readonly on "],
  [["bubblewrap.c:1881"], "--argv0 takes one argument"],
  [["bubblewrap.c:1946"], "--chdir takes one argument"],
  [["bubblewrap.c:2194"], "--mqueue takes an argument"],
  [["bubblewrap.c:2226"], "--file takes two arguments"],
  [["bubblewrap.c:2474"], "--userns takes an argument"],
  [["bubblewrap.c:793"], "Adding ambient capability "],
  [["utils.c:818"], "Can't read pid from socket"],
  [["bubblewrap.c:1192"], "Hostname argument is NULL"],
  [["bubblewrap.c:1229"], "Can't get type of source "],
  [["bubblewrap.c:1524", "bubblewrap.c:1550"], "Can't write data to file "],
  [["bubblewrap.c:1543"], "Can't create tmpfile for "],
  [["bubblewrap.c:2149"], "--file-label setup failed"],
  [["bubblewrap.c:2169"], "--tmpfs takes an argument"],
  [["bubblewrap.c:2514"], "--pidns takes an argument"],
  [["bubblewrap.c:2679"], "--perms takes an argument"],
  [["bubblewrap.c:611"], "Unable to open lock file "],
  [["utils.c:836"], "No pid returned on socket"],
  [["bubblewrap.c:1252"], "Can't mkdir parents for "],
  [["bubblewrap.c:1829"], "--args takes an argument"],
  [["bubblewrap.c:2116"], "--proc takes an argument"],
  [["bubblewrap.c:2706"], "--size takes an argument"],
  [["bubblewrap.c:927"], "unable to switch to uid "],
  [["bubblewrap.c:930"], "unable to switch to gid "],
  [["bubblewrap.c:1655"], "Can't find source path "],
  [["bubblewrap.c:2157"], "--dev takes an argument"],
  [["bubblewrap.c:2205"], "--dir takes an argument"],
  [["bubblewrap.c:2558"], "--uid takes an argument"],
  [["bubblewrap.c:2578"], "--gid takes an argument"],
  [["bubblewrap.c:273"], "Can't read seccomp data"],
  [["bubblewrap.c:3349"], "Creating newroot failed"],
  [["bubblewrap.c:3352"], "setting up newroot bind"],
  [["bubblewrap.c:3355"], "Creating oldroot failed"],
  [["bubblewrap.c:1162"], "Can't mount devpts on "],
  [["bubblewrap.c:1167"], "Can't mount mqueue on "],
  [["bubblewrap.c:1194"], "Can't set hostname to "],
  [
    [
      "bubblewrap.c:1441",
      "bubblewrap.c:1582",
      "bubblewrap.c:1584",
      "bubblewrap.c:1590",
      "bubblewrap.c:1592",
    ],
    "Can't make symlink at ",
  ],
  [["bubblewrap.c:1840"], "Can't read --args data"],
  [["bubblewrap.c:3200", "bubblewrap.c:3470"], "Setting userns2 failed"],
  [["bubblewrap.c:3329"], "Failed to make / slave"],
  [["utils.c:138"], "Can't fork for --pidns"],
  [["bubblewrap.c:1155"], "Can't mount tmpfs on "],
  [["bubblewrap.c:1266", "bubblewrap.c:1558"], "Can't create file at "],
  [["bubblewrap.c:1414", "bubblewrap.c:1420", "bubblewrap.c:1424"], "Can't create symlink "],
  [["bubblewrap.c:301"], "prctl(PR_SET_SECCOMP)"],
  [["bubblewrap.c:3333"], "Failed to mount tmpfs"],
  [["bubblewrap.c:532"], "Can't create signalfd"],
  [["utils.c:799"], "Can't set SO_PASSCRED"],
  [["bubblewrap.c:1136"], "Can't mount proc on "],
  [["bubblewrap.c:1287"], "Can't stat mount at "],
  [["bubblewrap.c:3243"], "Setting pidns failed"],
  [["bubblewrap.c:3460"], "pivot_root(/newroot)"],
  [["bubblewrap.c:3582"], "Can't fork for pid 1"],
  [["bubblewrap.c:621"], "Unable to lock file "],
  [["bubblewrap.c:805"], "Dropping capability "],
  [["bubblewrap.c:3374"], "chdir / (base path)"],
  [["bubblewrap.c:1011"], "setting up uid map"],
  [["bubblewrap.c:1026"], "setting up gid map"],
  [["bubblewrap.c:1402", "bubblewrap.c:1521"], "Can't create file "],
  [["bubblewrap.c:965"], "can't set dumpable"],
  [["bubblewrap.c:1129"], "Can't bind mount "],
  [["bubblewrap.c:3462"], "fchdir to oldroot"],
  [["bubblewrap.c:1605"], "Unexpected type "],
  [["bubblewrap.c:3068"], "Can't open /proc"],
  [["bubblewrap.c:3436"], "unmount old root"],
  [["bubblewrap.c:467"], "Write to info_fd"],
  [["bubblewrap.c:1546"], "Can't set mode "],
  [["bubblewrap.c:2765"], "Unknown option "],
  [["bubblewrap.c:3340"], "chdir base_path"],
  [["bubblewrap.c:3464"], "umount old root"],
  [["bubblewrap.c:3502"], "unshare user ns"],
  [["bubblewrap.c:3544"], "Can't chdir to "],
  [["utils.c:290"], "clearenv failed"],
  [["utils.c:304"], "unsetenv failed"],
  [["bubblewrap.c:1285"], "Can't stat fd "],
  [["bubblewrap.c:3252"], "unshare pid ns"],
  [["bubblewrap.c:3448"], "chdir /newroot"],
  [["utils.c:787"], "Can't send pid"],
  [["bubblewrap.c:1378"], "Can't access "],
  [["bubblewrap.c:1433", "bubblewrap.c:1436"], "Can't create "],
  [["bubblewrap.c:2565"], "Invalid uid: "],
  [["bubblewrap.c:2585"], "Invalid gid: "],
  [["bubblewrap.c:2636", "bubblewrap.c:2662"], "unknown cap: "],
  [["bubblewrap.c:572"], "read signalfd"],
  [["bubblewrap.c:703", "bubblewrap.c:742"], "capset failed"],
  [["bubblewrap.c:753"], "capget failed"],
  [["utils.c:297"], "setenv failed"],
  [
    [
      "bubblewrap.c:1263",
      "bubblewrap.c:1307",
      "bubblewrap.c:1347",
      "bubblewrap.c:1390",
      "bubblewrap.c:1470",
      "bubblewrap.c:1479",
      "bubblewrap.c:1492",
    ],
    "Can't mkdir ",
  ],
  [["bubblewrap.c:1507"], "Can't chmod "],
  [
    [
      "bubblewrap.c:1833",
      "bubblewrap.c:2030",
      "bubblewrap.c:2230",
      "bubblewrap.c:2256",
      "bubblewrap.c:2284",
      "bubblewrap.c:2337",
      "bubblewrap.c:2357",
      "bubblewrap.c:2377",
      "bubblewrap.c:2397",
      "bubblewrap.c:2417",
      "bubblewrap.c:2440",
      "bubblewrap.c:2460",
      "bubblewrap.c:2481",
      "bubblewrap.c:2501",
      "bubblewrap.c:2521",
    ],
    "Invalid fd: ",
  ],
  [["bubblewrap.c:3446"], "can't open /"],
  [["bubblewrap.c:482", "bubblewrap.c:558"], "read eventfd"],
  [["bubblewrap.c:3568"], "label_exec "],
  [["bubblewrap.c:404", "bubblewrap.c:420"], "sigprocmask"],
  [["bubblewrap.c:657"], "init wait()"],
  [["bubblewrap.c:991", "bubblewrap.c:2840"], "open /proc/"],
  [["bubblewrap.c:3371"], "pivot_root"],
  [["bubblewrap.c:1455"], "creating "],
  [["bubblewrap.c:3084", "bubblewrap.c:3121"], "eventfd()"],
  [["utils.c:1033", "utils.c:1043"], "vsnprintf"],
  [["bubblewrap.c:3129"], "pipe2()"],
  [["bubblewrap.c:3466"], "chdir /"],
  [["bubblewrap.c:3657"], "execvp "],
  [["bubblewrap.c:3565"], "setsid"],
  [["bubblewrap.c:391"], "prctl"],
  [["bubblewrap.c:549"], "poll"],
] as const;

const codexSites = [
  [
    ["linux_run_main.rs:311"],
    "permission profiles requiring direct runtime enforcement are incompatible with --use-legacy-landlock",
  ],
  [
    ["core/src/config/mod.rs:2675"],
    "config defines `[permissions]` profiles but does not set `default_permissions`",
  ],
  [["exec_util.rs:27"], "failed to read fd flags for preserved bubblewrap file descriptor "],
  [["exec_util.rs:38"], "failed to clear CLOEXEC for preserved bubblewrap file descriptor "],
  [["linux_run_main.rs:1048"], "failed to remove synthetic bubblewrap mount marker directory "],
  [["linux_run_main.rs:884"], "failed to create synthetic bubblewrap mount marker directory "],
  [["linux_run_main.rs:523"], "failed to place bubblewrap child in its own process group: "],
  [["linux_run_main.rs:987"], "failed to read synthetic bubblewrap mount marker directory "],
  [["linux_run_main.rs:1011"], "failed to remove stale synthetic bubblewrap mount marker "],
  [["linux_run_main.rs:1217"], "failed to open synthetic bubblewrap mount registry lock "],
  [["linux_run_main.rs:1032"], "failed to unregister synthetic bubblewrap mount target "],
  [["linux_run_main.rs:1204"], "failed to create synthetic bubblewrap mount registry "],
  [["linux_run_main.rs:1232"], "failed to unlock synthetic bubblewrap mount registry "],
  [["linux_run_main.rs:908"], "failed to register synthetic bubblewrap mount target "],
  [["linux_run_main.rs:1163"], "failed to inspect synthetic bubblewrap mount target "],
  [["linux_run_main.rs:783"], "failed to set bubblewrap child parent-death signal: "],
  [["linux_run_main.rs:994"], "failed to read synthetic bubblewrap mount marker in "],
  [["linux_run_main.rs:1083"], "failed to remove protected create marker directory "],
  [
    ["linux_run_main.rs:1175", "linux_run_main.rs:1184"],
    "failed to remove synthetic bubblewrap mount target ",
  ],
  [["linux_run_main.rs:1224"], "failed to lock synthetic bubblewrap mount registry "],
  [["linux_run_main.rs:432"], "bubblewrap argv is missing inner command after '--'"],
  [["linux_run_main.rs:933"], "failed to create protected create marker directory "],
  [["linux_run_main.rs:252"], "error applying legacy Linux sandbox restrictions: "],
  [["linux_run_main.rs:818"], "failed to install bubblewrap signal forwarder for "],
  [["linux_run_main.rs:420"], "bubblewrap argv is missing command separator '--'"],
  [["linux_run_main.rs:968"], "failed to read synthetic bubblewrap mount marker "],
  [["linux_run_main.rs:773"], "failed to restore bubblewrap forwarded signals: "],
  [["linux_run_main.rs:800"], "failed to restore bubblewrap signal handler for "],
  [["linux_run_main.rs:1436"], "managed proxy mode requires a proxy route spec"],
  [["linux_run_main.rs:182"], "managed proxy mode requires --proxy-route-spec"],
  [["linux_run_main.rs:759"], "failed to block bubblewrap forwarded signals: "],
  [["linux_run_main.rs:854"], "failed to reset bubblewrap signal handler for "],
  [["linux_run_main.rs:1063"], "failed to unregister protected create target "],
  [["linux_run_main.rs:1316"], "failed to create stderr pipe for bubblewrap: "],
  [["linux_run_main.rs:184"], "error activating Linux proxy routing bridge: "],
  [["linux_run_main.rs:220"], "failed to prepare host proxy routing bridge: "],
  [["linux_run_main.rs:690"], "failed to create bubblewrap exec start pipe: "],
  [["bundled_bwrap.rs:84"], "failed to normalize bundled bubblewrap path "],
  [["launcher.rs:90"], "failed to normalize system bubblewrap path "],
  [["linux_run_main.rs:1412"], "failed to resolve current executable path: "],
  [
    ["linux_run_main.rs:195", "linux_run_main.rs:208"],
    "error applying Linux sandbox restrictions: ",
  ],
  [["linux_run_main.rs:940"], "failed to register protected create target "],
  [["linux_run_main.rs:1335"], "failed to redirect stderr for bubblewrap: "],
  [["config/src/loader/mod.rs:1303"], "Failed to read project hooks config file "],
  [["linux_run_main.rs:1101"], "failed to remove protected create target "],
  [["linux_run_main.rs:440"], "failed to resolve current process argv[0]"],
  [["config/src/loader/mod.rs:1286"], "Error parsing project hooks config file "],
  [["linux_run_main.rs:1416"], "failed to serialize permission profile: "],
  [["linux_run_main.rs:271"], "missing permission profile configuration"],
  [["linux_run_main.rs:587"], "protected create monitor thread panicked"],
  [["bundled_bwrap.rs:133"], "failed to clone bundled bubblewrap fd: "],
  [["bundled_bwrap.rs:154"], "bundled bubblewrap digest mismatch for "],
  [["debug_sandbox.rs:240"], "failed to start managed network proxy: "],
  [["bundled_bwrap.rs:50"], "invalid bundled bubblewrap fd path: "],
  [["config/src/loader/mod.rs:1249"], "Failed to read project config file "],
  [["exec_util.rs:10"], "failed to convert argv to CString: "],
  [["linux_run_main.rs:400"], "error building bubblewrap command: "],
  [["bundled_bwrap.rs:121"], "invalid CODEX_BWRAP_SHA256 value: "],
  [["bundled_bwrap.rs:138"], "failed to read bundled bubblewrap "],
  [["bundled_bwrap.rs:38"], "failed to open bundled bubblewrap "],
  [["bundled_bwrap.rs:65"], "failed to exec bundled bubblewrap "],
  [["linux_run_main.rs:1353"], "failed to read bubblewrap stderr: "],
  [["utils/home-dir/src/lib.rs:46"], "failed to canonicalize CODEX_HOME "],
  [["launcher.rs:151"], "failed to exec system bubblewrap "],
  [["linux_run_main.rs:278"], "invalid permission profile JSON: "],
  [["launcher.rs:136"], "invalid system bubblewrap path: "],
  [["linux_run_main.rs:161"], "No command specified to execute."],
  [["linux_run_main.rs:514", "linux_run_main.rs:1324"], "failed to fork for bubblewrap: "],
  [["utils/home-dir/src/lib.rs:56"], "Could not find home directory"],
  [["bundled_bwrap.rs:174"], "invalid hex byte at offset "],
  [["config/src/loader/mod.rs:472"], "Failed to read config file "],
  [["launcher.rs:43"], "bubblewrap is unavailable:"],
  [["utils/home-dir/src/lib.rs:33"], "failed to read CODEX_HOME "],
  [["utils/home-dir/src/lib.rs:29", "utils/home-dir/src/lib.rs:40"], "CODEX_HOME points to "],
] as const;

const knownErrnos = new Set<number>(Object.values(constants.errno));
const cErrnos = [
  ["Operation not permitted", 1],
  ["No such file or directory", 2],
  ["Interrupted system call", 4],
  ["Input/output error", 5],
  ["Bad file descriptor", 9],
  ["Resource temporarily unavailable", 11],
  ["Out of memory", 12],
  ["Cannot allocate memory", 12],
  ["Permission denied", 13],
  ["Device or resource busy", 16],
  ["File exists", 17],
  ["Cross-device link", 18],
  ["No such device", 19],
  ["Not a directory", 20],
  ["Is a directory", 21],
  ["Invalid argument", 22],
  ["Too many open files", 24],
  ["No space left on device", 28],
  ["Read-only file system", 30],
  ["Broken pipe", 32],
  ["Function not implemented", 38],
  ["Too many levels of symbolic links", 40],
  ["Operation not supported", 95],
] as const;

function readErrno(line: string, format: "c" | "rust"): number | null {
  const rust = /\(os error ([1-9][0-9]{0,2})\)$/.exec(line);
  if (format === "rust") {
    if (!rust) {
      return null;
    }
    const value = Number(rust[1]);
    return knownErrnos.has(value) ? value : null;
  }
  // This pinned bubblewrap fatal literal follows its explicit errno == ENOSPC branch.
  if (
    line ===
    "bwrap: Creating new namespace failed: nesting depth or /proc/sys/user/max_*_namespaces exceeded (ENOSPC)"
  ) {
    return 28;
  }
  // Exact C-locale suffixes from strerror; no path or arbitrary number enters.
  const c = cErrnos.find(([text]) => line.endsWith(": " + text));
  if (c) {
    return c[1];
  }
  if (
    line.endsWith(
      ": Limit exceeded (ENOSPC). (Hint: Check that /proc/sys/fs/mount-max is sufficient, typically 100000)",
    )
  ) {
    return 28;
  }
  return null;
}

function bwrapReason(prefix: string) {
  if (/^(?:Creating new namespace|No permissions to create a new namespace)/.test(prefix)) {
    return "namespace-refused" as const;
  }
  if (
    /^(?:Can't (?:mount|bind mount|remount|make overlay mount)|pivot_root|u(?:n)?mount old root)/.test(
      prefix,
    )
  ) {
    return "mount-refused" as const;
  }
  if (/^(?:setting up (?:uid|gid) map|error writing to setgroups)/.test(prefix)) {
    return "uid-gid-map" as const;
  }
  if (prefix.startsWith("execvp ")) {
    return "payload-exec" as const;
  }
  return "helper-setup" as const;
}

function codexReason(prefix: string) {
  if (/^failed to exec (?:bundled|system) bubblewrap/.test(prefix)) {
    return "helper-exec" as const;
  }
  if (prefix.startsWith("bubblewrap is unavailable:")) {
    return "helper-unavailable" as const;
  }
  if (prefix.startsWith("bundled bubblewrap digest mismatch")) {
    return "helper-digest" as const;
  }
  if (prefix.startsWith("error applying Linux sandbox restrictions:")) {
    return "sandbox-restrictions" as const;
  }
  if (prefix.startsWith("error building bubblewrap command:")) {
    return "command-build" as const;
  }
  return "codex-diagnostic" as const;
}

type Site =
  | (typeof bwrapSites)[number][0][number]
  | (typeof codexSites)[number][0][number]
  | "execution-probe.go:fatal";
type Detail = {
  reason:
    | ReturnType<typeof bwrapReason>
    | ReturnType<typeof codexReason>
    | "probe-invalid"
    | "helper-unclassified"
    | "cli-unclassified"
    | "generic-os-error"
    | "unclassified-exit";
  sites: readonly Site[];
  errno: number | null;
};
function classify(stderr: string): Detail {
  let fallback: Detail = { reason: "unclassified-exit", sites: [], errno: null };
  for (const raw of stderr.split(/\r?\n/)) {
    let line = raw.trim();
    // Codex's /tmp alias warning is explicitly nonfatal. It must not mask a
    // later helper error. Only fatal source literals are listed above.
    if (/^warning:/i.test(line)) {
      continue;
    }
    const level = /^<([0-7])>/.exec(line);
    if (level) {
      if (Number(level[1]) > 3) {
        continue;
      }
      line = line.slice(level[0].length);
    }
    if (line.startsWith("bwrap: ")) {
      const diagnostic = line.slice(7);
      const match = bwrapSites.find(([, prefix]) => diagnostic.startsWith(prefix));
      if (match) {
        return { reason: bwrapReason(match[1]), sites: match[0], errno: readErrno(line, "c") };
      }
      fallback = { reason: "helper-unclassified", sites: [], errno: readErrno(line, "c") };
      continue;
    }
    if (line === "execution-probe-invalid") {
      return { reason: "probe-invalid", sites: ["execution-probe.go:fatal"], errno: null };
    }
    const diagnostic = line.replace(/^(?:Error|error): /, "");
    const match = codexSites.find(([, prefix]) => diagnostic.startsWith(prefix));
    if (match) {
      return { reason: codexReason(match[1]), sites: match[0], errno: readErrno(line, "rust") };
    }
    if (line.startsWith("Error: ")) {
      const errno = readErrno(line, "rust");
      fallback = {
        reason: errno === null ? "cli-unclassified" : "generic-os-error",
        sites: [],
        errno,
      };
    }
  }
  return fallback;
}

export function payloadCommandFailure(error: unknown) {
  if (!(error instanceof CommandFailure)) {
    return { reason: "spawn-or-command" as const };
  }
  const detail = classify(error.stderr);
  return {
    ...error.status,
    ...detail,
    reason: error.status.timedOut
      ? "timeout"
      : error.status.outputLimit
        ? "output-limit"
        : detail.reason,
  };
}
