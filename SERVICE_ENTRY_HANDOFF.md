# Foreground service entry handoff

Source patch only; integration owner applies/commits. One Git preflight failed:
linked metadata points outside the accessible worktree. No add/commit/push ran.
Input manifest pins gateway c7549d1e5ab816858c40064276565e3c5ca181d6 and production
native CLI 65ece8b7626cc5a492c8080d475f6b94ae5938fb. Frozen CLI SHA256 verified:
f5da4c6c4c4b90e12121528f7b607f6a75456c64c7ed07464c633665b48b3e9d.
Norm53 is sole authority; its bytes hash verified:
66a2393e7a55f76df1a78281af44379d0b455a0770d82f34e587dcca284157b0.
Worktree HEAD could not be verified through inaccessible linked Git metadata.
Launch from repository root, using installed qualified Node 24.21.x/dependencies:
`node services/account-gateway/src/serve.ts --config-file "$SERVICE_CONFIG_FILE"`
Package alternative: `pnpm --dir services/account-gateway start --config-file "$SERVICE_CONFIG_FILE"`.
The variable is an explicit protected pathname, never credentials or JSON.
Config is root-owned 0600, regular, single-link, <=64KiB, opened O_NOFOLLOW;
ancestors are protected. No dotenv, discovery, secret arguments or hot reload.
External operators apply native and kernel migrations BEFORE normal startup.
Operators supply the qualified production CLI executable and its SHA256,
root bootstrap file and root 0700 authority directory; Node never reads bootstrap.
Bootstrap must match fixed callback/native addresses, credentials, profile and limits.

Config types are authoritative in `services/account-gateway/src/service-config.ts`:
- `kernelDSN: string`; `facadeOrigin`, `callbackOrigin`: distinct fixed HTTP loopback origins.
- `native`: executable/bootstrapFile/authorityDir absolute paths, sha256/originRef strings,
  fixed loopback origin, nonzero uint32 uid/gid for the protected engine.
- `consumer`: one consumerId and distinct management/execution/cleanup/callback credentials.
- `profile`: fixed openai-responses-apikey-v1 profile, server-only model/baseURL/
  qualificationRef, five ApprovedLimits fields and providerTokenUpperBound.
- `bearers`: existing ManagementBearer/RunControlBearer[], same consumer,
  explicit owner/account/profile allowlists, limits and maxRunMs within catalog caps.
- `keys`: intentAEAD/intentHMAC/facadeHMAC canonical base64 strings decoding to
  distinct exact 32-byte keys. Retain outside DB/backup across restart.
Native custody key stays solely in protected Go bootstrap. CI receives no backend roles.

One unit supports one configured consumer, multiple ownerRefs/workspace accounts;
reuse existing SDK/private HTTP and consumer-owned policy. No per-org engine/admin.
Callback starts before spawn: eight live sockets/retained enrollment waiters, five seconds.
Only actual starting metadata installs authority; actual same-binding ready plus
initial heartbeat precede facade listening. All seven binding fields are retained;
pid/birthTicks/device/inode remain decimal strings. Worker UUID is independently fresh.
Authenticated inactive readback proves exact birth/profile/descriptor against fixed
catalog; no paid staging probe. Encrypted native custody relies on pinned implementation.
Actual credential/profile paid qualification is a separate required receipt.

One sequential bounded maintenance loop renews heartbeat/reconciles/claims cleanup.
Generation cleanup uses existing management; execution cleanup handles at most two
exact current-incarnation transports per tick under existing cleanup lease.
Only authenticated physical closure ACK releases occupancy; cancellation/timeout do not.
Signals/output loss stop admission/polls; bounded in-flight drain; SIGTERM original Go parent only.
Retired requires the same complete receipt binding, exact launcher scope/method and
zero parent exit. Uncertain teardown exits pending, retaining protected Go evidence;
the original parent may still be live. Operator reconciliation remains required.
No restart, ambiguous inference replay, foreign PID kill or authority reset.
Old-incarnation unknown effects/missing mappings remain pending; accepted effects survive.
SQL persists issuer/admissions/effects; issued bearer registry and associations are volatile.
Restart loses issued execution bearers; this entry supplies no persistent bearer registry,
automatic supervisor recovery, admission restoration or proven cleanup SLO.
Memory/deadline/cgroup qualification and repeated-burst retained-heap evidence remain open.

Executed: Node 24.21.0 parse and type-erasure syntax checks for four new TS files PASS;
CLI argument rejection (exit2/config_denied), dependency rejection (exit1/startup_denied)
PASS without stack/vendor output; existing SDK topology guard PASS.
Meaningful typecheck NOT_RUN: pnpm wrapper requires absent corepack; no tsc/dependencies.
Foundation and Docs guards NOT_RUN with the same normal missing-corepack output.
Actual service test NOT_RUN: pg import missing; production image/fixture also absent.
No install/build/provider/GitHub/deploy operations or other workers' edits occurred.
Primary must run pinned `pnpm exec tsc --project services/account-gateway/tsconfig.json`,
`pnpm foundation`, `pnpm docs:check`, then the one actual lifecycle test below.
Test command: `AG_SERVICE_ENTRY_ALLOW=new_disposable_root_pg17_10 node --test services/account-gateway/test/service-runtime.test.ts`.
Primary supplies `/opt/account-gateway-service-entry/fixture.json` (protected 0600),
production `account-gateway` image, protected TLS server.pem/server-key.pem and normal
system-trusted CA, NEW externally migrated paired ag_service_entry_kernel_/native_
PG17.10 databases with matching 32-hex suffix, and protected disposable root config.
Manifest fields: serviceConfig/nativeDSN/gatewaySourceRef/nativeSourceRef/normHash.
No DSN/key environment variables. Test covers safe create/run-control prepare,
two sequential completed Responses in SAME OPEN concurrency1, closure permitting
second dispatch, wrong-role denial, original enrolled proof and exact parent retirement.
No optional migration helper was changed. No lifecycle PASS is claimed.
Full Dmin Codex tools/final/parser/App, Dfinal/S/E/F/G remain mandatory; H deferred.
No release or production cutover approval is implied. NO FAST; account-v scope only.
