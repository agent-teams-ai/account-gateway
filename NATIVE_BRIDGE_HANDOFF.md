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
