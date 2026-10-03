# Private kernel wire-policy bridge

## B2 durable account occupancy and exact local closure — 2026-10-03

This checkpoint owns only `services/account-gateway/`: domain, PostgreSQL adapter,
new `002_transport_occupancy.sql`, actual PostgreSQL tests and this handoff.
`001_kernel.sql` remains byte identical (SHA-256
`160df664385b2a4ad8bfca2e98a5619f04322b1e2453c3f5e10a3f7d941ead15`).
SDK/kernel repairs and other native/RR/review lanes are preserved. No dependency,
framework, scheduler, ORM, public wire/HTTP/auth/proxy/UI or native bootstrap
change is included. Requested implementation profile is explicit
`gpt-6.1-sol/high/default`, NO FAST; integration review is `xhigh/default`.

Requested base is exact merged `1ea091f8`, whose tree the controller identifies
as identical to independently APPROVED `9f0f65bb`, with PR3 merged and both exact
CI passing. These are supplied identities, not observed forge evidence here.
The linked `.git` resolves outside the sandbox to inaccessible worktree metadata;
`git rev-parse HEAD` and status fail, and its index-lock directory is not writable.
No add, commit or push occurred. External patch receipts hash every observed
service preimage, result, patch and the unchanged migration. The guard requires
HEAD equal to resolved `1ea091f8`, its tree equal to resolved `9f0f65bb`, exact
preimage bytes and absence of the new migration before integration. Any mismatch
must stop; this worker cannot attest the checkout's Git tree itself. Main owns
application and commit with author and committer iliya <iliyazelenkog@gmail.com>.

### Private API and durable schema

`requests.transport_occupied` is independent of `effect`; `closure_token` is
permanent, and `requests.worker` is its original owner. 002 additionally rejects
UPDATEs that change consumer/execution/request identity, original worker or closure
token (including legacy NULL tokens), so future adapters cannot rebind or rotate
an issued proof. Acknowledged closed occupancy also cannot be reopened by UPDATE.
New dispatch results require a token in the private domain type;
only legacy cleanup descriptors allow it to be absent. The
first actual claim records occupancy and a random UUID proof in the same consumer
row-serialized transaction as permanent request spending. Only its dispatch result
returns `closure: {executionRef, requestRef, worker, token}`. Duplicate/readback
claims never reissue a permit or proof. Safe request/operation/account DTOs remain
positive allowlists and never contain closure proof or native descriptors.

For this single-profile slice, `Bounds.maxConcurrent` also bounds occupied local
transports across ALL executions for the same consumer/account, including old
physical generations and closed/fenced executions. Each execution retains its
narrower persisted approved concurrency and exact envelope matching. Admission
counts occupancy by joining persisted execution account identity under the same
consumer serialization, after reconciling expired ownership across that account.
Reconciliation prioritizes occupied rows, at most the hard ceiling of 128; legacy
overfull accounts stay denied while bounded classification progresses. Another
account or consumer is unaffected. All writers must use the same configured bound.
Request count and stored token allowance are never refunded or widened by closure;
actual transport/provider byte/token enforcement remains B3/D work.

`acknowledgeTransportClosed(context, worker, proof, cleanup?)` accepts only the
exact persisted consumer/execution/request/original-worker/token. Original owner
acknowledgements remain valid after lease expiry. An exact late ack classifies
still-in-flight expired ownership as durable unknown/fenced before committing,
and preserves already unknown or completed effects. Closure changes occupancy
alone after that necessary loss classification; it never unfences, refunds or
permits old-attempt replay. Exact repeated owner acks are idempotent, and an old
proof cannot close a different newer request. A trusted adapter must call this
only after independent local context/body/transport closure evidence, including
completed deliveries; failed callbacks, timeout, upstream cancellation assumptions
and credential generation erasure provide no such evidence.

Cleanup's execution scope now returns a bounded `transports` page of exact durable
closure descriptors. `cleanupTransports(context, cleanupRef, worker, token)`
reads another page of still-occupied requests, only for the exact currently leased
execution cleanup owner. Pages cap at `min(maintenanceBatch, 128)`; acknowledging
one page advances the next read without a new dispatch permit. Proven new rows
precede unproven legacy rows, so missing legacy authority cannot hide newer proofs. Delegated closure
acks pass `{cleanupRef, token}` and additionally qualify the UPDATE by that exact
execution scope, cleanup worker/token and DB-clock lease. Reclaimed cleanup rotates
its CAS token, never the request proof. Done-job duplicate closure acks are allowed
only for already closed matching requests and the exact final cleanup owner/token.
Generation cleanup cannot release transport occupancy. Execution cleanup success
is rejected until every matching occupied transport is independently acknowledged;
failed settlement and stale leases cannot release it. Restart can reconstruct the
proofs without the original dispatch permit RAM. Callback effects remain monotonic.
All new command objects capture whitelisted primitives before validation/await.

### Safe numbered upgrade and qualification limits

Apply unchanged 001 then 002 to a NEW fixture; for an existing private 001 schema,
stop all old writers and supervise/quiesce local transports before applying 002
once. Mixed old/new writers are unsafe: old writers cannot record the new contract.
Do not rewrite/reset 001 or automatically clear occupancy during deployment.
002 conservatively retains every legacy dispatched row, including completed and
unknown effects, as occupied with NO manufactured proof. Legacy descriptors have
no token; closure through this port is refused and execution cleanup stays pending.
Separately authorized exact offline reset after independently proved real closure
would be required for such rows; no reset authority/tool or migration platform is
implemented. This first slice has never run production. Quiescence, lease timeout
or deletion of credentials alone cannot be substituted for transport closure.

The real-PG fixture now applies sorted numbered migrations and seeds synthetic
001-shaped legacy rows between 001 and 002 in its NEW empty disposable database.
All 19 existing PostgreSQL cases remain, with explicit closure setup where capacity
must be reused; the restart case isolates a second account. Eight new actual-PG
cases cover distinct-execution contention/isolation, narrower execution bounds,
loss and exact late ack, completion/failed callbacks, bounded restart cleanup CAS,
old generation/credential cleanup/restore, mutable closure/cleanup commands and
legacy upgrade. The DB contract case attempts actual rewrites of all five proof
binding fields, attempts to reopen a confirmed closure, and requires constraint
rejection plus unchanged durable identity;
the completion case reuses the same execution for a newer delivery and verifies
a duplicate expired-owner proof cannot free that new slot. Each new case starts with an old-production observable-behavior
assertion before relying on new closure API/schema fields. No mocks, source-string
assertions, compiler-failure regression oracle or test-only production hooks exist.

Worker checks: Node 24.21.0 syntax checks and domain 2/2 PASS. Typecheck, all 27
actual PostgreSQL cases, old-production negative qualification, frozen pnpm install,
build/root/Foundation/topology, Docs Protocol and exact CI/review are NOT_RUN here.
There is no node_modules, pnpm's corepack launcher is unavailable, no main-owned
PG17.10 fixture was supplied here, and no PostgreSQL client is installed. No install, DB launch/provision,
credential/provider access or real user project was used. Main must run pinned
pnpm11.28.2 and PostgreSQL17.10 outside this provider sandbox in a NEW fixture,
then run the eight B2 cases against actual old 1ea production in a separate NEW
fixture (retain new tests and numbered migrations). A failing negative test must
show its initial behavioral assertion, not an absent method/column or compiler
failure. Use the commands and strict disposable-DB guards below; full exact-byte
qualification remains outstanding. B2 establishes a private durable contract only;
no live provider, actual transport or supervisor acceptance is claimed.

Historical qualification sections below apply to earlier patches only. Their
per-execution-only accounting and fresh-schema-only limitations are superseded
by B2 above, and no historical PASS qualifies this candidate.

## Primary F3 qualification - 2026-10-03

Main verified guarded patch325a0807 against exact aea6ed03 in a NEW sandbox.
Frozen pnpm11.28.2 install, typecheck, domain2, build, root26, Foundation and
static topology passed. Actual PostgreSQL17.10 passed all19 cases, zero skips.
In a separate NEW database the one F3 behavior test failed on unchanged aea
production: the durable identity became B instead of originally supplied A.
Tests are actual consumer-row-lock waits and durable claim descriptors.
No native/provider effects or product/facade acceptance claimed. Historical
worker NOT_RUN below records what the worker itself did, not this primary run.
Final exact-head CI and independent xhigh/default review remain required.

## Current F3 native proof capture repair - 2026-10-03

This bounded repair changes only `src/postgres.ts`, `test/postgres.test.ts`
and this handoff under `services/account-gateway/`. F1/F2, the consumer-context
capture and all existing tests remain intact. Earlier qualification and scope
statements below describe previous patches, not qualification of this F3 repair.

Requested base: exact `aea6ed03` kernel. The linked `.git` points to missing
external worktree metadata; HEAD, index-lock writability and Git identity cannot
be verified here. No commit/push was attempted. The external guarded patch
requires the owner to verify HEAD resolves to `aea6ed03` and all three observed
preimage SHA-256 values before applying. A mismatch must stop integration;
this worker cannot independently attest that the observed files equal that Git tree.
Main owns integration with author and committer iliya <iliyazelenkog@gmail.com>.
Requested execution profile: `gpt-6.1-sol/high/default`, NO FAST.

`acknowledgeCandidate` copies only generation, nativePhysicalIdentity and profile
before validation or any await. All existing validation, conflict checks and
persistence use that same captured primitive object.

Exactly one new actual-PG regression uses existing `mutateAtConsumerLock` on a
fresh creating candidate whose native identity is NULL. It submits valid proof A,
mutates the caller to valid unused identity B while the real consumer row is
locked, then requires durable identity and a later claim descriptor to remain A,
exact A replay to succeed, and B to conflict. Old production rereads B after the
lock and should fail the persisted-A assertion; that negative run is NOT_RUN here.

Local Node syntax verification is recorded in external evidence. TypeScript,
Docs Protocol and PostgreSQL qualification are NOT_RUN here: dependencies are
absent and main owns pinned fixture qualification outside the provider sandbox.
Main must run all 19 PG cases on NEW disposable PostgreSQL 17.10 and demonstrate
this single F3 test fails against actual `aea6ed03` production in a separate NEW
fixture before qualifying the exact repaired bytes. Existing toolchain and DB
guards below apply. No install, test DB launch, provisioning, provider call,
credential access, schema/framework or public API change occurred.

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
