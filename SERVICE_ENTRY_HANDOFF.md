# PR11 startup cancellation repair handoff

Preparation only; root goal ACTIVE. Primary owns actual qualification and integration.
Only changed: services/account-gateway/src/service.ts,
services/account-gateway/test/service-runtime.test.ts, SERVICE_ENTRY_HANDOFF.md.
Supplied owner source: 9367f64a71a60b0539f38c10841b8bd06e1ce5f2.
Supplied base: c7549d1e5ab816858c40064276565e3c5ca181d6.
.spike-inputs/manifest.json agrees with supplied owner source; Git HEAD unverified.
Linked Git metadata and index.lock/HEAD.lock probes return missing parent metadata;
no history, locks, staging, commits or pushes were changed. PR11 history is preserved.
Norm53 sole authority: .spike-inputs/contract53.md, full bytes read and SHA256 verified:
66a2393e7a55f76df1a78281af44379d0b455a0770d82f34e587dcca284157b0.
Original .spike-inputs/p92-review.md CHANGES_REQUIRED read in full.

service.ts: stopping/invalid/exit/abort guards cover every awaited startup probe,
callback listen, original-binding wait, readiness wait, heartbeat and facade listen.
Each next listener/authority/native-child acquisition has a preceding guard.
Shutdown wakes startup metadata waits; failed startup also closes all current servers
again after memoized stop, covering a listen completing after its shutdown snapshot.
Memoized bounded shutdown, admission denial, original ChildProcess-only SIGTERM,
seven-field exact retirement binding, receipt scope/method and zero exit are retained.
Accepted effects/occupancy and sanitized diagnostics retain their existing semantics.
No second resource manager, hooks, retries, scheduler or ingress/auth weakening.

Nearest regression remains inside the ONE actual PG17.10 production-CLI lifecycle.
Hold ACCESS EXCLUSIVE on ag_kernel.requests; observe the LAST startup schema SELECT
waiting on that exact lock holder via database/query-scoped pg_stat_activity.
Abort while blocked, then ROLLBACK; require startup_denied within 15 seconds.
Require no direct child and an untouched empty protected authority directory;
rebind callback/facade/native ports, then run the existing two Responses scenario.
This requires a fresh empty authority directory and Linux /proc child observation.
Old source snapshots an unbound callback at abort, then binds it after the last probe
returns; memoized stop misses it, so the callback port rebind must fail.
Earlier probes are unsuitable: pool.end() rejects the next SQL before listener bind.
This is a source-derived counterexample; historical RED has NOT been executed here.
Existing raw requests now supply BOTH Accept and Content-Type application/json;
200/403, SAME OPEN concurrency1, physical closure ACK and exact retirement stay intact.

Diff limits verified against saved input bytes: production +20/-9; nearest test +50/-5.
Read-only git apply --check against saved input bytes PASS; current hashes match receipt.
Meaningful typecheck attempted: tsc --project services/account-gateway/tsconfig.json;
NOT_RUN, shell exit 127 (tsc absent); dependencies/node_modules are also unavailable.
No install/corepack exploration, Node fixture/runtime, Go, Docker, agent or paid calls.
Primary must typecheck with pinned TypeScript 7.0.2, then run old RED -> fixed GREEN
in new disposable PG17.10 containers with all four kernel/all embedded native migrations,
normal controlled TLS and the existing protected fixture manifest/configuration.
RED uses the repaired fixture with saved original service.ts; GREEN uses patched service.ts.
Actual command: AG_SERVICE_ENTRY_ALLOW=new_disposable_root_pg17_10 node --test services/account-gateway/test/service-runtime.test.ts.
Supplied production image: 9344ab4ad52717332de4eeea051a4e83e58d2a02f43cb48e8aad7ee146b16f00.
Supplied native: 65ece8b7626cc5a492c8080d475f6b94ae5938fb; Go1.27.1/CGO0 (minimum1.27.0).
Prior actual fixture reached Node and failed; owned failed container retained, no lifecycle PASS.
Missing headers are source-observed; no further executed failure cause is asserted.
Actual provider/App calls remain zero. All runtime qualification here is NOT_RUN.
Remaining D-min: actual Codex tools, final parsed review and exact-approved-head App publication.
D-final, S/E/F/G remain mandatory; H deferred; no production/release approval implied.
Patch and preimages: /srv/worker-state/jobs/account-gateway/first-slice-v1/jobs/account-gateway-20261003-service-repair-p94/tmp/agent/p94-repair/.
No service-config/SDK/kernel/native/protocol/dependency/platform or other workers' edits.

## Primary qualification, 2026-10-05

Pinned TS7.0.2 service/SDK, Foundation source policy: PASS on exported product source.
ONE new disposable PG17.10 fixture used production Go1.27.1/CGO0 CLI from native65ece8b7.
All four kernel and all native embedded migrations applied externally, empty rows verified.
Normal controlled TLS, no upstream/provider/App credentials or paid effects.
Original9367 service + same repaired test: observed rollback-port-unavailable after abort;
Node retained leaked listener and exceeded operator's bounded95s wait. RED, no PASS count.
Fixed service: actual lifecycle1PASS0FAIL; abort leaves ports/authority/no-child clear,
then authenticated account create, two SAME OPEN concurrency1 Responses, physical closure ACK,
and exact original seven-field parent retirement with zero exit.
GREEN container2a37ef91cc109a6930c048da5af24af656c46e5144a04bb94f2d166135a9ab84.
RED container9c07b3b31e4c303faba9f8de90718fb23dac51989a0eeaf06f12e57f573f8ee2.
GREEN qualification76f0992f836f21991326fdea09cfaba77fcd7fdc23a08fe9a03ba4d6400f235a.
Production image9344ab4ad52717332de4eeea051a4e83e58d2a02f43cb48e8aad7ee146b16f00.
Failed earlier fixtures had an intermediate unmounted dependency symlink; no service test ran.
Primary corrected only fixture dependency paths. Qualification operator is test-only external
evidence, excluded from exported product source/PR and Foundation governed test tree.
Test uses independent fixture input projection and safe error.code, not private config loader;
existing HTTPS server proves port release without widening allowed imports/entrypoints.
Independent exact-source review/full current CI pending. D-min paid tools/final/App NOT_RUN;
D-final/S/E/F/G still required; H deferred. No production deployment/release/retirement.
