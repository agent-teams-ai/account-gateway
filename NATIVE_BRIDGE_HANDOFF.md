# Private Node–Go bridge handoff

Bounded source patch against supplied c56e764a52256aa24699e20a1cdcc0dc83c61f29.
The five modified existing files' original bytes match that candidate's supplied
SHA-256 identities. Dependency c56 was independently reviewed and accepted as
gateway main4df4a14b; this bridge remains an unaccepted candidate.

`NativeAuthority` composes the existing kernel/read/store ports and fixed private
callback listener. `NativeHTTPTransport` implements the existing facade port:
one raw-payload inference POST, captured callback as sole claim, bounded streaming,
same-proof owner read/ACK, and actual leased delegate cleanup. Existing SQL owns
effects and occupancy. Only authenticated positive physical facts can ACK closure;
completion requires native completed/effect facts. Uncertainty fences the original
execution without inference replay. The added cleanup reader only reads existing
claimed execution cleanup rows, retaining microsecond expiry precision.

Trusted outer composition must supply fixed Go origin, separate per-consumer
execution/cleanup/callback credentials, protected origin/incarnation/worker and
qualification, and explicit profile/caps. Bind the callback listener on loopback.
No composition, SDK, management, migrations, dependencies, locks, Go, launcher,
runtime or provider changes are included. No commit/push/deploy or provider calls.

Verification: Node 24.21.0 syntax checks and the five existing ingress scanner
regressions passed. Meaningful TS7 typechecking is NOT_RUN: the installed pnpm
wrapper references absent corepack; dependencies/types/compiler are unavailable.
The new TCP/SQL suite is NOT_RUN: `pg` is absent and no designated fresh disposable
PG17.10 database is available. Foundation checking is NOT_RUN: installed CLI absent.
These are optional worker prerequisites, not qualification passes.

Primary commands with its normal pinned dependencies: `pnpm --dir
services/account-gateway run typecheck`; `node --test
services/account-gateway/test/native-transport-postgres.test.ts`; installed
`pnpm run foundation`. The suite requires `AG_KERNEL_TEST_ALLOW=disposable_pg17_10`,
`AG_NATIVE_BRIDGE_DISPOSABLE_DB=ag_kernel_test_<fresh_name>` and matching loopback
`AG_NATIVE_BRIDGE_TEST_DSN`, PostgreSQL 17.10 and no existing ag_kernel/ag_management
namespaces. CI supplies its own separate empty database; `test:pg` includes the suite.

Tests explicitly use a synthetic Go peer over actual TCP and real SQL: two single
claims/entries within one OPEN execution at concurrency1; positive owner ACK;
EOF/unclosed/CloseFailed/abort/cap ambiguity; lost/duplicate admit ACK; exact tuple,
birth, nonce, expiry and cleanup scope; expired owner closure versus dispatch; and
HTTP hardening. They are runnable regressions, not actual Go/provider evidence.

Native PR5/source700 merged as093 is the supplied wire/registry input. The separate
Go bootstrap/owner-route lane is planned contract, not actual assembly evidence.
Primary must qualify `/read-owner`, `/cancel-owner`, `/ack-owner`, callback lifetime
schema, actual Node/Go/PG and provider behavior. Dmin tools → final → parser → same
approved-head App remains unproved; UI/batching and S/E/F/G remain downstream,
H sharing deferred. Bounds here are enforced configuration, not measured readiness.

Git admin preflight was inaccessible; no retry/reset/index action was used. The
exact bounded patch, per-file SHA-256 manifest and evidence are in the job's writable
`tmp/agent/native-http-bridge-artifacts` directory. The worktree diff is left intact
for controller application/review/commit. No other lane's workspace was edited.

## Primary qualification, 2026-10-04

Terminal worker output retained as unqualified patch 88f7835a. In an isolated clone, fixed synthetic fixture reuse of the same native ID/birth pair; production uniqueness unchanged. Actual pinned TS7 typecheck, build and Foundation source-boundary check passed. New disposable PG17.10 plus real TCP suite: 9 PASS, 0 FAIL, 0 SKIP, including two requests in the same open execution at concurrency1. The peer is synthetic Go; actual protected Go/Node/SQL assembly and provider/RR tools/final/App remain unproved.

## Independent P1/P2 correction, 2026-10-04

Supplied source c5a93858d8bc0141f4310a389034740142b6c52e, PR8; independent
`.spike-inputs/independent-review.md` REQUEST_CHANGES. Normative full53 SHA-256:
`66a2393e7a55f76df1a78281af44379d0b455a0770d82f34e587dcca284157b0` (verified).
P1 keeps SQL's immutable owner A proof; configured B must independently validate
its actual exact current cleanup lease/scope. Dispatch/admit still require B.
P2 reclaims definitely unstarted routes and SQL-denied/no-proof routes; exact
SQL closure ACK matches the latched reservation even before proof attachment.
Unknown/lost claim or POST remains retained; no replay, timed eviction or new ledger.
Nine existing cases remain; four new real-SQL/TCP regressions cover A-expired/B-current,
pre-POST failures, limit saturation/recovery and actual facade ACK-before-proof barrier.
Worker verification: Node 24.21.0; five ingress tests PASS. TS contract typecheck
NOT_RUN: pnpm's corepack target/compiler/types absent. PG/TCP and original-red
execution NOT_RUN: pg/dependencies and a designated disposable PG17.10 unavailable.
Primary must run the existing typecheck and exact PG fixture commands above with
pinned dependencies and a fresh designated DB; synthetic peer is not provider E2E.
One Git preflight failed on inaccessible linked-worktree metadata; no retry/commit/push.
Exact bounded patch and before/after hashes: job `tmp/agent/p1p2-fix` artifacts.
Only the two native TS modules, nearest PG/TCP test and this handoff are owned.
Actual authenticated Node/Go/SQL assembly and provider/RR qualification remain incomplete.

## Primary P1/P2 qualification

Fresh isolated PG17.10 plus real TCP: all four new regressions fail on original
c5 production; repaired source passes 13 tests with zero failures/skips.
Pinned TS7 typecheck passes after one test-only helper annotation matching the
actual string request-id port; no production repair beyond the worker patch.
Receipts: qualification-node-p1p2-v1/results. Synthetic Go peer only; actual
Go/Node/SQL, provider and RR final/App remain separate unproved acceptance.
