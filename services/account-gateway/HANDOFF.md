# Private kernel wire-policy bridge

This candidate adds only `services/account-gateway/`. It copies the immutable
original kernel and completes its private persistence policy before the future
HTTP facade. SDK, engine/native identity, root workspace, native lock and CI
remain under their respective writers. No commit, push, provisioning, provider
inference, credential access or global runtime/product change was performed.

## Source and qualification identity

The controller supplied canonical main source `07234f60` and stated its source
tree equals reviewed `226a090`. These are supplied identities. Git observation
failed because the linked worktree metadata is inaccessible; no Git SHA was
inferred. `EVIDENCE.json` records fingerprints of the actual available source,
SDK authority and candidate files. All 21 immutable input hashes were verified.

The retained receipt at
`.spike-inputs/evidence/qualification-kernel-24a13795-v1/results.json` qualifies
**prior candidate 24a13795**: native frozen-lock integration/install, TypeScript,
domain 2/2 and actual PostgreSQL 9/9 PASS, including the late-deadline race.
Those results do not qualify this changed candidate. New candidate: local Node
24.21.0 domain 2/2 and syntax checks PASS; TypeScript, frozen install and all 13
PostgreSQL cases NOT_RUN. Dependencies are absent and no worker DB is designated.
Only main may run heavy qualification in a NEW dedicated sandbox.

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
Receipts: `qualification-kernel-10354c7d-v1`. Earlier worker NOT_RUN statements
describe worker-local availability; this paragraph records later controller work.

Promise-returning port validation remains async. Cleanup tokens/ownership,
issuer restore, physical-generation proof checks and monotonic accepted effects
are preserved. Synthetic descriptor UUIDs establish only kernel DB contracts;
actual native physical identity and provider pinning require the separate engine
writer's qualification. Readback/restore/reconcile never replay inference.
Current concurrency/request accounting is per execution. Account-global provider
admission, native transport byte/token enforcement and the HTTP service remain
dependent B work; this unused private kernel does not establish those gates.

## Main qualification and integration

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
There is no generated checkpoint patch inside the source tree. This handoff does
not assert new PG/typecheck PASS, public HTTP acceptance, native identity
qualification, production capacity, production cutover or public release.
