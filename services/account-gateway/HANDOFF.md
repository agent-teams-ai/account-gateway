# B2 account occupancy and exact local closure handoff

## Unqualified mechanical continuation — 2026-10-03

Continue only from supplied checkpoint
`be978224d36636540f86d86c06ac1b0b76178e0b`. The prior worker ended in terminal
`task_timeout`; the owner mechanically preserved patch `f83208b6`. Neither that
checkpoint nor this continuation has accepted product, PostgreSQL, type or
independent source-review qualification. Historical main/PG PASS receipts have
been removed from this handoff: they do not qualify these bytes.

This worker owns only `services/account-gateway/`. The checkpoint already contains
the B2 domain, PostgreSQL adapter, numbered migration and 27 actual-PG cases;
this continuation preserves that implementation and strengthens the legacy fixture.
SDK/kernel settlement, HTTP, native/C1, UI, RR, root workflows, dependencies and
locks remain separate scopes. No commit, push, deploy, provisioning or inference
is authorized here. Main owns integration and verifies author and committer
`iliya <iliyazelenkog@gmail.com>`.

The single Git preflight failed because the linked metadata path
`source-b2-partial-f83208b6/.git/worktrees/kernel-account-occupancy-b2-finish` is
unavailable. No Git retry, index write, commit or push was attempted. HEAD, lock
writability, exact checkpoint identity and the comparison to merged
`1ea091f8` are **UNVERIFIED** here. No accessible merged-1ea source export was
found in the bounded input inspection. Source inspection of the preserved service
files is worker implementation work, not an accepted independent review.
Integration must verify checkpoint HEAD and every exact preimage before applying
the continuation patch; stop on any mismatch. Do not apply this delta to 1ea or
recreate B2 from 1ea. Main separately compares the cumulative B2 diff to merged1ea.

## Durable private contract

`Bounds.maxConcurrent` limits occupied local transports across every execution
in the same consumer/account, including older generations and closed/fenced
executions. Persisted execution concurrency remains a narrower bound. Claim
matches the persisted private admission envelope and counts account/execution
occupancy under the existing consumer-row transaction lock, after reconciling
expired ownership across that account. Other accounts and consumers are isolated.
All writers must use the same configured bound. Reconciliation is bounded at 128
rows for admission; overfull legacy accounts remain denied while classification
progresses. Request count and stored token allowance are permanent; closure never
refunds, widens, unfences or grants replay.

`requests.transport_occupied` is independent of effect. A dispatched request
permanently binds execution, request, original worker and a UUID `closure_token`.
002 prevents updates rebinding those fields or reopening acknowledged occupancy.
Only the initial dispatch claim returns the private one-request closure descriptor;
duplicate claims return safe status without a permit. Safe RequestStatus,
OperationStatus and account DTOs remain allowlists without closure/native material.

`acknowledgeTransportClosed(context, worker, proof, cleanup?)` releases only the
exact persisted consumer/execution/request/original-worker/token. Original-owner
acknowledgement works after its worker lease expires and is idempotent. A late ack
classifies still-active expired ownership as unknown/fenced in the same transaction;
already completed/unknown effects remain unchanged. Wrong, stale or different
request proofs cannot release a slot. Completion, failed callbacks, owner loss,
revoke/close/restore, credential erasure and assumed upstream cancellation never
independently clear occupancy. A trusted caller must first independently confirm
local body/context/transport closure, including for completed delivery.

Execution cleanup claims expose bounded durable `transports` descriptors;
`cleanupTransports` pages remaining occupancy for the exact leased execution
cleanup owner. Pages cap at min(maintenanceBatch, 128); proven requests precede
legacy unproven requests. Delegated closure acknowledgement requires the exact
execution scope, cleanup worker, CAS token and unexpired DB-clock cleanup lease.
Reclaim rotates cleanup CAS, never the request proof. Done-job duplicate acks are
accepted only for already closed matching requests and the final exact owner/token.
Execution cleanup success is refused while any matching transport remains occupied.
Generation cleanup does not release execution transports. New closure/cleanup
command objects capture whitelisted primitives before validation or any await.

## Numbered migration and fixture

`001_kernel.sql` is unchanged, SHA-256
`160df664385b2a4ad8bfca2e98a5619f04322b1e2453c3f5e10a3f7d941ead15`.
Apply 001 then real `002_transport_occupancy.sql` on a NEW empty disposable fixture.
The actual-PG fixture seeds genuine 001-shaped rows between those migrations:
active dispatch/response, completed, unknown and denied requests. The four accepted
rows remain occupied with no manufactured closure token; only never-dispatched
rows start unoccupied. The legacy test checks active effects survive migration,
expired active effects subsequently become unknown without releasing capacity,
terminal effects remain monotonic, request_count remains four, and cleanup refuses
unproven closure. Admission cannot silently free an upgrading account's slots.

For an existing private 001 schema, stop old writers before applying 002 once.
Mixed writers cannot implement this contract. Do not reset 001 or infer closure
from deployment quiescence, a timeout or credential deletion. Legacy accepted
requests deliberately lack closure authority and keep cleanup pending. A separately
approved exact offline reset after independently proved transport closure would
be needed; this patch adds no reset tool or migration platform. This first slice
has never run production.

## Main qualification and remaining gates

Main subsequently qualified owner checkpoint `8b62ea62b1e829e21d651e412ed77f9af5aea205`:
pinned frozen install, TypeScript, domain 2/2, fresh PostgreSQL 17.10 27/27 with zero
skips, build, root 26/26, Foundation, topology and Docs Protocol passed. Evidence:
`qualification-kernel-b2-final-873be837-v1/result.json` in the durable workstream.
Exact-head kernel and package CI also passed. Independent xhigh review is pending.

The later review fix keeps the SQL002 occupancy default conservative for accepted
inserts that omit new fields, with an actual SQL/account-capacity regression. Its
before control failed behaviorally on old8b62 (0 occupied slots instead of 1);
the corrected fresh PostgreSQL 17.10 suite passed all 28 cases with zero skips,
and typecheck passed. Evidence: `qualification-b2-conservative-default-v1/result.json`.
The original account-wide race also failed on actual merged1ea production
(2 dispatches instead of 1), with successful setup and no missing API or compiler
failure: `qualification-b2-original-capacity-negative-v1/result.json`. SQL001
is unchanged. No native transport, supervisor or product gate is accepted here.

### Historical continuation worker checks

Current execution receipts are external to the source tree. All qualification
claims must bind their result hashes. Node 24.21.0 syntax checks and both domain tests passed locally; exact final
file hashes and per-command exit codes are recorded in external evidence. These
checks do not establish PostgreSQL correctness. The pnpm launcher is present but
its referenced corepack binary is missing, so pnpm qualification cannot run.

**NOT_RUN by the continuation worker:** TypeScript, frozen dependency install, formatter,
all 27 actual PostgreSQL cases, before-source negative controls, build/root tests,
Foundation/topology, Docs Protocol, exact CI, independent xhigh source review and
product/actual transport/supervisor acceptance. No node_modules, tsc or psql were
present at preflight. No dependencies or DB were installed or provisioned here.
Main supplies pinned pnpm 11.28.2, Node 24.21.x and a NEW PostgreSQL 17.10 fixture.

The main qualification recipe runs typecheck, domain tests and all PG cases with zero skips.
The test guard requires `AG_KERNEL_TEST_ALLOW=disposable_pg17_10`, a newly created
localhost DB named `ag_kernel_test_[a-z0-9_]+`, `AG_KERNEL_DISPOSABLE_DB` equal to
that name and a matching locally supplied `AG_KERNEL_TEST_DSN`. Never export the
DSN or vendor bodies. The fixture refuses an existing ag_kernel schema and leaves
its new schema for inspection; it never drops/reset an old DB.

Retain the eight named B2 actual-PG cases. In a separate NEW disposable DB, main
runs them against actual merged1ea production while retaining these tests and
numbered migrations. The regressions first assert observed old-boundary behavior
(account admission or premature cleanup), before using the new closure APIs;
failure must identify that behavioral assertion, not missing columns/methods or
compiler failure. Legacy upgrade additionally reads only preexisting effect
fields before its admission oracle. No mock-only or source-string tests qualify.

Separate **future integration gates**: SDK/kernel settlement and concrete transport
adapters must carry private closure evidence and acknowledge completed delivery;
cleanup/supervisor must independently confirm closure in B3/D. Existing outer
settlement alone cannot satisfy the new contract. `rejected_before_dispatch` is a
later additive boundary checkpoint; no public SDK change is included here. Main
also runs the cumulative <=2000-LOC check, exact-head CI and independent xhigh
review. B2 is a private durable contract, not live-provider acceptance.

Main commands after providing the guarded NEW disposable fixture locally:

```sh
pnpm --filter @agent-teams/account-gateway-kernel typecheck
pnpm --filter @agent-teams/account-gateway-kernel test:domain
pnpm --filter @agent-teams/account-gateway-kernel test:pg
# Separate NEW negative-control fixture with old merged1ea production only:
node --test --test-concurrency=1 --test-name-pattern='^B2 ' services/account-gateway/test/postgres.test.ts
```

Continuation artifacts (outside the source worktree) are in
`/srv/worker-state/jobs/account-gateway/first-slice-v1/jobs/account-gateway-20261003-kernel-account-occupancy-b2-finish/tmp/agent/b2-finish-artifacts/`:
`preimages.json`, `continuation.patch`, `guard.json`, `apply-guarded.py` and
`verification.json`. The patch is a delta from the observed mechanical checkpoint,
not a replacement/cumulative patch from merged1ea. The guard verifies exact HEAD,
all five preimages, patch hash and unchanged 001 before applying; it performs no
commit/push. `verification.json` carries truthful NOT_RUN gates.
