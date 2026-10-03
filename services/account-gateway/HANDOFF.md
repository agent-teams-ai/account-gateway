# Private kernel wire-policy bridge

The original kernel producer owned only `services/account-gateway/`. The
assembled PR3 also includes root workspace/lockfile, Foundation policy and CI
integration supplied by other writers. This F1/F2 remediation owns only
`services/account-gateway/src/postgres.ts`, `services/account-gateway/test/postgres.test.ts`
and this `HANDOFF.md`; native and RR C1 writers own their other workspaces.
No commit, push, provisioning, provider inference or credential access occurred.

## Source and qualification identity

The requested reviewed head is `5f07a18be3e5650495bd0b942b09f9438df50309`.
Main reports that all 69 independent-review public-source fingerprints matched
its authoritative 5f Git tree. The local `.spike-inputs/REVIEW.md` is integrity-bound
review data; its F1/P1 and F2/P2 REQUEST_CHANGES define this bounded patch.
Linked Git metadata is unavailable, so that supplied identity is not represented
as an observed HEAD. The guarded external patch records exact observed preimage
and result SHA-256 values. Candidate-only `EVIDENCE.json` was removed because its
old e9 fingerprints and superseding claims contradicted later main evidence.

Historical main qualification applies to guarded patch
`10354c7d1847ed300b6dcf20c0665b620b6195e3cfcd150149abc1cc149f8d9f`:
`.spike-inputs/qualification/results.json` reports frozen installation,
TypeScript and domain PASS; `postgres.log` records 13/13 actual PG PASS.
These supplied receipts match `.spike-inputs/INPUT-HASHES.json`.
They do **not** qualify the new remediation.

Current worker checks: Node 24.21.0 domain 2/2 PASS and syntax checks for the
changed PostgreSQL adapter and test file PASS (see external exact-byte evidence).
Typecheck, actual Foundation/source-policy behavior, Docs Protocol validation,
frozen installation and all 18 PostgreSQL cases are NOT_RUN here: dependencies
are absent, and main owns fresh database and CI qualification. No install or
DB gate wait was performed. Main must run the new exact patch through these
gates and independent `gpt-6.1-sol/xhigh/default` review.

## Current F1/F2 and trusted-context patch

F1: fresh claim reuses bounded request-loss reconciliation scoped to its execution
inside the existing serialized consumer transaction. It classifies expired
`dispatch_started`/`response_started` ownership as `effect_unknown`/`owner_lost`,
fences and idempotently queues execution cleanup before admission evaluation.
The new request commits `not_dispatched`/`fenced`; no classification exception
rolls it back. The scoped bound uses persisted execution concurrency rather than the
maintenance batch. Completed effects and unrelated live executions survive.

F2: `beginAccount` snapshots every known primitive at entry, before validation
and the first await. Validation, intent, operation identity, lookup, CAS and
mutation use that same snapshot. Transaction bookkeeping also captures the
trusted consumer once before its first await. Structural caller mutation cannot
switch issuer bookkeeping or business effects to another existing consumer;
authentication remains the outer trusted boundary.

Three additional actual-PG regressions are named `F1 claim fences expired
in-flight ownership before spare-concurrency admission`, `F2 beginAccount
snapshots caller primitives before the consumer-row await`, and `transaction
snapshots trusted consumer before awaits despite structurally mutable context`.
F1 uses concurrency 2, exact W1 expiry and fresh W2 claim without callback or
maintenance, then checks durable denial/ambiguity/fence, one cleanup, replay
and new-ID denial, completed monotonicity and unrelated live execution safety.
The mutation regressions observe the real DB session blocked on the consumer
row using existing snapshot-refresh and pool-idle fixes, then inspect persisted
account/intent/replay and foreign-consumer isolation. The response-started loss
uses the shared SQL predicate; no duplicate response-only test was added.

Implementation request: `gpt-6.1-sol/high/default`, NO FAST. This patch remains
pending main's NEW synthetic PG qualification, before-regression run against
actual old 5f production plus the new tests, typecheck, existing policy/CI gates,
and independent exact-fingerprint `gpt-6.1-sol/xhigh/default` review. Historical
15-PG/code/CI receipts below do not qualify this patch. No empirical gates were
added to self-approval; no DB gate was invoked or awaited here.

## Bounded PR3 remediation

1. Effect progression now checks the exact worker's DB-clock lease and qualifies
   the UPDATE with that lease. Expired in-flight callbacks commit `effect_unknown`
   with `owner_lost`, execution fencing and durable cleanup. Returning the status
   commits classification; throwing inside the transaction would roll it back.
   Same-state callbacks also check the lease. Terminal accepted completion remains
   monotonic, and readback never yields a dispatch permit. A new real PG case
   expires exact leases before maintenance, observes durable unknown/fencing and
   tests duplicate/fresh-id replay denial plus completed-effect preservation.
2. Restore enqueues generation cleanup for every quarantined candidate in the
   same transaction: ready, creating, staged and previously quarantined, including
   absent native identity. Existing generation uniqueness keeps repeated restore idempotent.
   A new PG case claims and settles active and pending-generation cleanup,
   preserves absent physical identity, checks exact scopes and foreign isolation,
   and verifies repeated restore before and after settlement.
3. Stale candidate-only evidence is removed; historical main 13/13 proof above
   remains explicitly tied to prior 103 rather than the new changes.
4. Source-policy tests clone actual governed sources, manifests and policy into
   disposable fixtures and invoke the installed Foundation CLI. Type-only `pg`
   imports mutate only the fixture. Valid-policy checks precede negative checks;
   actual domain bytes are verified pristine. SIGKILL can leave only temp files.
   Actual CLI behavior still requires main's installed dependencies.
5. SQL adds `(consumer, account_ref)` indexes for candidates and open executions
   used by account disable. No ORM, framework or scheduler was added.
6. Original producer ownership and assembled PR ownership are distinguished above.
7. TS configuration sets `lib: [ES2024]` and `erasableSyntaxOnly: true` for Node
   stripping. Full TypeScript qualification remains with main.
8. Kernel workflow concurrency is keyed by workflow/ref and cancels superseded runs.
9. Domain tests independently reject concurrency 129 with requests 300, accept
   the 128 ceiling and retain requests 32/concurrency 33 cross-field rejection.
10. Actual DB lock observation has a bounded 15-second monotonic timeout without
    replay/retry. The deadline case records a claim transaction starting before
    expiry, waits to its persisted deadline using DB time, and releases the lock
    after observed expiry. Its fixture allows 10 seconds for setup; production
    deadlines and admission behavior are unchanged.

## Policy and private persistence

Preparation uses `invocationRef` plus opaque string `attemptRef`, without numeric
conversion. PostgreSQL uniquely binds consumer/invocation/attempt. Same intent
under another operation ID reads back the same sticky execution; conflicting
intent cannot replace it. Unknown outcomes keep that identity fenced.

Preparation persists independent policy and binding revisions, profile, deadline
and all approved limits: requests, concurrency, request bytes, output bytes and
tokens. Policy/binding revisions support zero through `Number.MAX_SAFE_INTEGER`
using PostgreSQL bigint and explicit numeric decoding. Metadata CAS accepts zero
as a revision and can conflict with the stored positive account revision.

`PrivateAdmission` represents the actual SDK admission fields plus private
execution/issuer identity. Before a new permit, claim matches invocation,
attempt, account, authorization epoch, subject, policy revision, binding
revision, profile, every limit and expiry against the persisted preparation.
Expiry compares instants, so equivalent offsets and trailing fractional zeros
work. Nonzero fractions finer than the persisted millisecond deny the permit;
JavaScript Date truncation cannot make an extended expiry match. Live authority,
issuer, generation, acknowledged fence and DB-clock deadline checks still apply.
Approval and nested limits are copied before the first await.

The first committed claim alone returns a protected-private descriptor and
persisted limits/deadline for the future transport adapter. Request totals and
concurrency are enforced here. Body/output/token transport enforcement, provider
token enforcement and capacity qualification are pending; storing a numeric
limit does not prove them. No native request body, output, credential or plain
credential hash is stored. `intentDigest` remains an opaque token supplied by a
future trusted HMAC ingress; this kernel does not implement that ingress.

Pure policy imports no SDK, Zod, framework or vendor DTO. Domain bounds select
server policy, rather than validating public wire syntax. Defaults are bounded
engineering values, not measured capacity: 32 requests, concurrency 1, 1 MiB
request, 4 MiB output, 100,000 tokens and a one-hour run. The outer facade must
use the existing SDK versioned schema authority and map internal account/profile,
epoch/state and preparation names at that boundary. No additional wire schema,
HTTP server, authentication service or renewal mechanism was added.

The `accounts` private port returns only safe summaries. Its PostgreSQL adapter
filters by authenticated consumer and optional owner, uses UUID keyset order,
and caps pages at 100. A cursor is an ordering bound, not an existence lookup.
Product owner/role authorization and HTTP authentication belong outside this
private port. No native identity or descriptor appears in account/readback DTOs.

## Tests and lifecycle preservation

All original nine PostgreSQL cases remain: durable operation/candidate uniqueness;
conflicting operation race; staging/rename/reconnect CAS; acknowledged fence vs
claim with accepted effects; sticky preparation/duplicate/unknown fencing; atomic
limits and blocked deadline; restart vs restore; cleanup lease reclamation; and
consumer isolation/immutable owner/safe readback. The sticky race now also
contends with distinct operation IDs on the same opaque attempt.

Four additional real-DB cases cover the complete stale envelope and equivalent
expiry instants; every limit/binding in operation and sticky intent plus bigint
revisions; conflicting approval contention and distinct opaque attempts with
consumer-bound readback; and >100-row account listing/filter/keyset isolation.
Races use distinct backend PIDs and observe actual PostgreSQL lock contention.
There are no mock-only or source-string assertions and no duplicated HTTP tests.
The two pure domain cases retain independent bounds and immutable configuration
checks, extended for the new numeric configuration.

Main qualification on 2026-10-03 of guarded patch `10354c7d` passed frozen
installation, TypeScript, both domain cases and all 13 actual PostgreSQL 17.10
cases on a new empty disposable database. The two stale-envelope fixtures now
use explicitly bounded test instances to compare valid but different concurrency
values; production defaults and validation were preserved. Root integration also
passed build, 24 tests and actual Foundation/dev-only checks; the new Foundation
boundaries govern private source and tests and reject database types in policy.
Supplied receipts are under `.spike-inputs/qualification/` and match the input
hash manifest. This is historical main evidence for prior 103; current worker
NOT_RUN gates above describe this new remediation.

Promise-returning port validation remains async. Cleanup tokens/ownership,
issuer restore, physical-generation proof checks and monotonic accepted effects
are preserved. Synthetic descriptor UUIDs establish only kernel DB contracts;
actual native physical identity and provider pinning require the separate engine
writer's qualification. Readback/restore/reconcile never replay inference.
Current concurrency/request accounting is per execution. Account-global provider
admission, native transport byte/token enforcement and the HTTP service remain
dependent B work; this unused private kernel does not establish those gates.

## Historical main qualification - 2026-10-03

Main assembled the reviewed-source-base remediation with merged SDK PR2
`83f0c7ca` and corrected two observed test-harness failures: PostgreSQL activity
snapshots retained an earlier idle transaction; the ten-second deadline barrier
also let the pool close an observed backend. The harness now explicitly refreshes
PG activity snapshots and keeps its two test-only backend identities alive.
No production lease, deadline or admission policy was relaxed.

Assembled source patch `b24715c89865aa3a1b1b43a9954cd24ce5fad521d128864fc76867e0aafedfef`
passed frozen install, TypeScript, domain 2/2, build, all 26 root tests, actual
Foundation/source-policy and dev-only checks, and PostgreSQL 15/15 in a NEW
empty PG17.10 fixture. Receipts are retained under
`qualification-kernel-integrated-b24715c8-v1` in main-owned durable evidence.
Earlier 4706 and 7193 fixtures retain the real harness failures; they are not
claimed PASS. These receipts qualify the prior assembled code only; they do not qualify this
F1/F2/context patch or its three new PG regressions. Independent exact-commit
xhigh review and final CI remain pending.
The additional text in this handoff records completed main evidence; it is not
an observed Git identity or a claim that the worker ran those gates.

## Main qualification and integration

Main qualified guarded F1/F2/context patch
`eb8cda287cfb560c7c6681fe1299a078a1a4920cbd6dcd027bb82272b9f746cb`
on the exact `5f07a18` base in a NEW isolated fixture. Frozen installation,
TypeScript, domain 2/2, build, root 26/26, Foundation/source policy and topology
passed. Actual PostgreSQL 17.10 passed all 18 cases with zero skips. A separate
NEW database using actual old `5f07a18` production and the three new behavioral
tests failed all three: a forbidden R2 dispatch permit, changed A-to-B intent,
and broken consumer bookkeeping. Evidence is retained externally under
`qualification-kernel-eb8cda28-v1` and `qualification-kernel-eb8-before-v1`.
An initial fixture command used the wrong internal PostgreSQL port and did not
create a database; the corrected command ran only the unproved DB phase.
These results establish the bounded kernel repairs, not account-wide capacity,
transport, UI or real-provider E2E. Independent review and final exact-head CI
remain required before merge.

Main owns workspace inclusion and its single native lockfile. Use the qualified
Node 24.21.x / TypeScript 7.0.2 toolchain, retain installed version receipts and
run these against this fingerprinted candidate in a NEW dedicated sandbox:

```sh
pnpm install --frozen-lockfile
pnpm --dir services/account-gateway run typecheck
pnpm --dir services/account-gateway run test:domain
AG_KERNEL_TEST_ALLOW=disposable_pg17_10 pnpm --dir services/account-gateway run test:pg
```

Main privately supplies `AG_KERNEL_TEST_DSN` and `AG_KERNEL_DISPOSABLE_DB` for a
NEW localhost PostgreSQL 17.10 DB named `ag_kernel_test_[a-z0-9_]+`; never print
the DSN. The harness refuses an existing kernel schema, remote/unmatched DSNs,
URL options and other server versions. It retains the disposable schema rather
than dropping it. Use a new DB for every complete rerun.

This is a fresh private schema, not an upgrade/migration of a deployed service.
Main must review the exact candidate with `gpt-6.1-sol/xhigh`, serviceTier default,
and integrate/commit with author and committer iliya <iliyazelenkog@gmail.com>.
Guarded patch and evidence live outside the source tree in the worker artifact
directory. This handoff does not assert new PG/typecheck/source-policy PASS, public HTTP acceptance, native identity
qualification, production capacity, production cutover or public release.
