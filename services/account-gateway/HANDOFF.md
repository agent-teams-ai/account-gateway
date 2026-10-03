# B2a trusted native proof and positive pre-entry rejection

This is an unqualified guarded implementation packet. Primary owns frozen pinned
qualification, independent exact-source xhigh review, integration and commits.
The controller verifies author and committer are iliya <iliyazelenkog@gmail.com>.

## Source and inputs

Requested accepted main: `ded1530216501416605293398a970bbf3e19d092`.
Observed HEAD: **UNVERIFIED**. The linked Git administrative directory is absent;
the one index.lock preflight returned ENOENT. No Git/index mutation was retried.
Source files remain byte-identical to the captured preimages. Apply only after
the controller checks the requested HEAD, every entry in preimages.json and
the patch SHA256 from guard.json. Preserve concurrent management/SQL004 and Go
custody changes. There are no unowned changes in this patch.

Contract53: `66a2393e7a55f76df1a78281af44379d0b455a0770d82f34e587dcca284157b0`.
Q: `fdf2099991d7d7e36f9e636c3029e136104c2c22e5005bb9cbde38c1cd555fa0`.
Exact supplied bytes are retained in the packet's inputs/ directory.
Q protects consumer-owned primitive domain contracts from PG and SDK DTOs.
The SDK feature contracts file remains the single public effect/schema authority.

Unchanged SQL001 SHA256:
`160df664385b2a4ad8bfca2e98a5619f04322b1e2453c3f5e10a3f7d941ead15`.
Unchanged SQL002 SHA256:
`65695ee98f728082e7131df8293ae8d1fd0c353321a2de9d769fad5dbd7fe546`.
No dependencies, lockfiles, root configuration/workflows, facade, management,
native, launcher or UI are modified. No installs, provider calls, credentials,
runtime/provisioning checks, commits, pushes, deployment or package release.

## Trusted boundary and durable behavior

claim(context, executionRef, requestId, worker, admission, reservation) requires
a NativeReservation with opaque originRef, engineIncarnation UUID and requestNonce
UUID. Trusted server composition must obtain it from an authenticated native
callback, never from caller URLs, client admission fields or CI bodies. B2a does
not authenticate/enroll a live native process; that is an explicit B3 gate.

Claim snapshots the whitelisted reservation and existing complete admission
primitives before the pool/transaction await. The sole accepted insert permanently
stores the original consumer/execution/request/worker and closure token alongside
origin/incarnation/nonce and descriptor generation. The first claim alone returns
dispatch.closure, now a NativeDispatchProof containing the exact private native
binding. Duplicate claims return only safe status, including mismatched valid
reservations. A spent origin/incarnation/nonce cannot be repurposed onto another
request/execution in the same consumer; consumer serialization and SQL003's
partial unique index enforce that tombstone after closure/restore.

rejectBeforeDispatch(context, worker, proof, false) is a dedicated trusted
settlement, requiring the exact immutable dispatch/closure tuple, original current
worker lease and dispatch_started effect. Literal entered:false is mandatory.
Wrong origin/incarnation/nonce/generation/worker/token and other scope are denied;
response_started, completed and effect_unknown cannot be relabeled. An exact
duplicate may read prior rejection after lease expiry and never rearm it.
Generic effect(next) excludes rejected_before_dispatch both in types and at runtime.

Positive rejection commits rejected_before_dispatch/native_rejected, keeps the
execution open and retains transport occupancy. Each accepted claim permanently
spends its request slot and original per-request token cap. limits.tokens remains
output+reasoning per request; requests*tokens is the conservative allowance ceiling.
There is no refund/billing ledger, retry, failover, replay, renewal or scheduler.

Only separate exact acknowledgeTransportClosed releases occupancy. It requires
the native binding as well as original worker/token/scope; cleanup delegation
retains existing execution lease/CAS checks. Cleanup reads the durable original
native binding and never returns a dispatch permit. Bounded pages prioritize
complete native proofs ahead of legacy tokens without native authority, so legacy
occupancy does not prevent provable closures from progressing. Deadline, revoke, owner loss,
restore, erasure and effect completion do not themselves release occupancy.
Loss of the original lease during a valid rejection settlement returns committed
effect_unknown/owner_lost and a durable fence, rather than throwing and rolling
back that fact. Late non-entry reports cannot rehabilitate unknown. Accepted
rejection survives later owner loss/restore/cleanup classification.

Apply numbered003 once after unchanged001/002 with old writers stopped. SQL003
retains existing rows' exact occupancy/token, adds NULL native bindings without
backfill authority, enforces all-or-none new binding and immutable generation/
origin/incarnation/nonce, and preserves rejection as terminal. Legacy accepted
rows cannot gain native authority or release occupancy via guessed proofs, even
when an old SQL002 closure token exists. Their cleanup remains pending; no reset
or grant reopening is added.

SDK effectState adds rejected_before_dispatch. Safe positive errors require
retry.kind=never; request status requires failed plus a consistent safe error,
and operation readback permits that effect only in rejected state. Unknown,
completed, missing-error and retry-inferred variants are rejected. Strict public
schemas and internal safe status projections exclude the private tuple/proof.

## Tests and actual worker checks

Twelve new behavior tests state their regression before each test. Eleven use the
real guarded migrated PostgreSQL fixture; one tests public wire validators with
independent literal payloads in the existing owned PostgreSQL TS test module.
Existing claim/race/cleanup tests are preserved and supply explicit test-only
native reservations. No mocks, source-string tests or production test hooks.

Coverage: rejection then occupied capacity denial; exact closure then fresh
request with permanently spent budget; every binding mismatch and generic bypass;
duplicate callback race/readback; post-response/completed/unknown denial; durable
lost-lease unknown/fencing and lost settlement; mutation across an observed actual
DB transaction lock wait; immutable SQL binding, cleanup restart/CAS and restore;
real pre003 accepted NULL-native row with an old token; native nonce reuse across
request/execution identities; bounded cleanup progress before legacy token rows;
positive/negative literal SDK wire payloads.

The supplied tree has **no tests/validation.test.mjs**. Creating a new handwritten
MJS test is prohibited, so wire assertions are in the existing owned
services/account-gateway/test/postgres.test.ts, within the service's meaningful
TypeScript project. They run with its real PG qualification; no absent test file
or unrelated tests were invented/edited. Primary should confirm this supplied-tree
discrepancy when integrating.

Worker PASS: Node 24.21.0 executes the two unchanged domain tests against the
candidate domain, 2/2, zero skips. Final TypeScript stripping/module syntax for
all four edited TS files: PASS 4/4. These are syntax checks only.
Direct node --check on TS initially failed because that CLI path does not strip
TypeScript; raw receipts are retained. The final syntax check uses Node's built-in
stripTypeScriptTypes and SourceTextModule without resolving/evaluating imports.

**NOT_RUN:** TypeScript typecheck, frozen pinned dependencies, every real PG/SDK
behavior case, SDK build/root suites, Foundation/topology/Docs Protocol, exact-head
CI and independent xhigh review. No node_modules, tsc, psql or disposable fixture
are available. pnpm's launcher references a missing corepack binary. No replacement
tools/dependencies/DB were installed. This packet claims no PG/product acceptance.

Primary's installed pinned environment uses Node24.21.x, pnpm11.28.2,
TypeScript7.0.2, pg/@types-pg8.23.1 and a NEW disposable PostgreSQL17.10 database.
Use the existing AG_KERNEL_TEST_ALLOW=disposable_pg17_10 designation, a localhost
ag_kernel_test_[a-z0-9_]+ database with matching AG_KERNEL_DISPOSABLE_DB, and supply
AG_KERNEL_TEST_DSN locally without logging/exporting it. The fixture refuses an
existing schema and retains the new schema for inspection. Never use real projects.

Commands after guarded integration and primary-provided frozen dependencies:

```sh
pnpm --filter @agent-teams/account-gateway-kernel typecheck
pnpm --filter @agent-teams/account-gateway-kernel test:domain
pnpm --filter @agent-teams/account-gateway-kernel test:pg
pnpm build
pnpm test
pnpm foundation
pnpm check:topology
pnpm docs:check
```

Primary must run the complete existing PG suite plus all B2a tests with zero skips,
then exact-source gpt-6.1-sol/xhigh/default review. Model/effort/serviceTier cannot
be set or attested by this worker's callable tools; requested writer configuration
is gpt-6.1-sol/high/default, NO FAST. Runtime declares network enabled, but full
Internet capability is unverified and cannot be expanded through these tools.
Filesystem/credential isolation was preserved; no secret paths were read.

Remaining B3 gates: real authenticated native process/incarnation enrollment,
private callback/settlement composition, physical transport/body/context closure,
protected launcher/inherited-lock and exact old-process retirement qualification.
This additive kernel/SDK packet does not establish those product/runtime gates.

## Packet file hashes

Exact candidate and preimage hashes, input digests, patch digest, actual checks
and patch reconstruction/source-preservation receipts live in guard.json and
verification.json next to changes.patch. Those external manifests include this
handoff's digest without a circular self-reference.

## Primary qualification - 2026-10-03

The owner verified the exact ded15302 base, every preimage and guarded worker
patch75c7629f before materializing a separate qualification clone. SQL001/002
remain unchanged. The actual initial PG37/40 failed one stale independent test
SELECT and two direct SQL calls because SQL003's trigger referenced executions
through caller search_path. The table is now schema-qualified; the test reads
the full immutable proof. A completed-effect nonce control uses APIs present
in both versions, with actual old production admitting a spent nonce (valid
behavioral failure, not a missing API).

Public wire coverage belongs to the existing SDK HTTP client suite, not a
cross-package private import in the neutral kernel PG fixture. It checks exact
positive non-entry status, contradictory statuses/errors, private proof rejection
and one request per public invocation. No architecture exception or dependency
was added. Source/installed boundary schemas remain SDK-owned.

Pinned frozen pnpm11.28.2, TypeScript7 typecheck, SDK build/domain2, root27 HTTP/
architecture/docs behavior cases, Foundation, Docs Protocol and topology pass.
The final separate39-case PG17.10 receipt is retained in the primary qualification
directory. Independent exact-source xhigh review and current CI remain required.
This unused checkpoint does not qualify native registration, process closure,
launcher, facade authentication, providers, product UI, deploy or assembled E2E.
