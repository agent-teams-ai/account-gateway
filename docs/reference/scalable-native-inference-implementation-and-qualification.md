---
id: docs.reference.scalable-native-inference
type: reference
status: proposed
owner: gateway-maintainers
summary: Implemented Go inference and TypeScript control boundaries, qualification gates, rollout requirements and measured evidence.
---

# Scalable native inference implementation and qualification

## Overview

The owner approved implementation on 2026-10-23: keep TypeScript SDK and account
control, move public inference bytes, provider adaptation, streaming and
cancellation to the existing Go engine, and qualify the complete path. Changes
are staged in dependent branches in account-gateway and sub2api; production
deployment and public package publication are outside this implementation.

The baseline is account-gateway f3e061d and native b813197. The prior qualification
used an API-key controlled provider, sixteen occupied streams and brief arrival
steps. It does not establish Codex/Claude OAuth or thousand-stream capacity.

Implementation is staged in [account-gateway PR 71](https://github.com/agent-teams-ai/account-gateway/pull/71)
and [sub2api PR 64](https://github.com/agent-teams-ai/sub2api/pull/64). PR 71 depends
on the preceding cloud-load/control-progress branch, PR 69. The expanded fixture
pins native `b48f89102e0ed8375cdc1838d2701718aae76bb1`; each CI receipt records the
exact gateway/native commits, binary hashes, dependency manifests and runtimes.

## Contract

### Invariants

- A persisted current execution, account generation, policy fence, issuer and
  worker lease authorize each dispatch. Public clients never receive private
  native peer credentials, descriptors or closure proofs.
- One atomic durable claim and native entry CAS govern each original request.
  Inference has no hidden retry, provider failover or replay after ambiguity.
- Expiry, cancellation and revoke cannot erase an accepted unknown effect or
  release transport occupancy without exact physical closure evidence.
- Provider credentials and request/response bodies are absent from diagnostics.
- Public data admission and private control retain independent finite bounds.
  Capacity settings are operator inputs; only measured profiles are qualified.
- Historical SQL migration checksums remain unchanged. The lock-order migration
  requires old kernel writers to stop before application.

### Approved implementation sequence

1. Release Claude physical SQL guards after response headers and staged passive
   limit capture, before the SSE body pump. Preserve revision-checked cache write,
   physical stream ownership and cancellation. Prove progress with four SQL
   connections and at least five concurrent controlled-provider streams.
2. Replace heavyweight read transactions with read-only consistent snapshots;
   combine dispatch reads; acquire the global budget only for actual charging or
   tightening. The new consumer-before-budget order must cover direct triggers,
   first-consumer creation and every mutation without a reverse lock edge.
3. Replace per-process accumulation of execution bearer records with stable,
   purpose-separated authenticated execution locators. Bind issuer identity,
   consumer, execution, original admission tuple and expiry; revalidate durable
   current state on use and preserve safe original readback.
4. Add a separate bounded Go public listener. Metadata-only authenticated
   callbacks provide current execution authority, durable claim and terminal
   settlement. Go owns request bytes, response backpressure and physical closure;
   failed settlement retains original evidence for existing cleanup recovery.
   The legacy private transport and TS execution path remain compatible.
5. Qualify standard client protocol adapters explicitly. A Responses-to-Messages
   upstream adapter is not itself a public Anthropic Messages API. SDK inference
   origin is separate from control origin and accepts only explicitly configured
   transport policy.
6. Address continuous-operation retention with expiring replay namespaces and
   irreversible retirement fences before reclaiming positively settled history.
   Unknown effects and occupied transport proofs remain retained. Increasing a
   counter ceiling or deleting arbitrary old request IDs is not a solution.
7. Run production assembly, higher-concurrency and sustained workload scenarios,
   then independent exact-source critics and repairs. Preserve all failures and
   distinguish offered, accepted, refused, canceled and completed requests.

### Qualification gates

Use pinned Node 26.11.1 and compatibility Node 24.21.0, Go 1.27.3 and disposable
PostgreSQL 17.10. Reuse the frozen dependency lockfiles. Tests use sandbox accounts
and controlled TLS providers; external provider traffic is not a load fixture.

Required evidence covers protocol compatibility, duplicate/revoked/expired
capabilities, cross-consumer SQL progress, final-slot budget conservation, slow
readers, cancel, owner loss, settlement recovery and clean process/DB retirement.
Scale profiles report concurrent streams, offered and accepted request rate,
payload bytes, response duration, CPU/RSS scope, event-loop delay, SQL waits and
cleanup time. Long contexts and continuous create/close churn are separate axes.

## Examples

The SDK sends account and lifecycle controls to its configured TypeScript origin
and inference to its explicitly configured Go inference origin. A production
edge router may expose one external origin while preserving separate internal
listeners. A client request cannot select a native/provider URL.

At an illustrative twenty-second mean response time, one thousand continuously
occupied sequential agents mean about fifty new requests per second and one
thousand streams. One thousand new requests per second instead mean about twenty
thousand streams. Neither scenario is qualified by the baseline sixteen-slot run.

## Evidence status

Implementation and source-level repairs are published. Both complete package and
kernel qualification passed for gateway commit
`d371dc530e9fb4420c0d616890c6c3e9676927e5`:

- [Package qualification](https://github.com/agent-teams-ai/account-gateway/actions/runs/39983757117)
- [Kernel qualification](https://github.com/agent-teams-ai/account-gateway/actions/runs/39983757119)

Fresh disposable PostgreSQL checks passed 59 kernel tests and 74 OAuth enrollment
tests on each required Node version, without skips. Actual pinned CLI processes
and the Claude SQL-guard regressions passed in the isolated cloud fixture.
The [reproducible client workflow](https://github.com/agent-teams-ai/account-gateway/actions/runs/39983757364)
passed on both Node versions: all 11 public-ingress and 2 bootstrap race tests,
both Claude PostgreSQL regressions and both actual client processes, with no
skips, no external network, sanitized evidence and positive PostgreSQL shutdown.
The corrected two-CPU stream profile passed through 1024 simultaneous streams;
the same run exposed a pre-claim overload classification defect in the arrival
and large-context profiles, described below. The PRs link each subsequent
source-pinned qualification run and its complete results. A previous successful
profile does not qualify a later source revision or a different load shape.
Only successful receipts establish their corresponding load qualification;
source review does not imply production capacity.

## Implemented operator contract

The TypeScript SDK and service retain account lifecycle, execution issuance,
policy checks and durable usage. Public inference bodies, provider adaptation,
streaming, backpressure and cancellation run in Go. TypeScript still participates
in every request through finite metadata callbacks; SQL and callback throughput
remain capacity limits even when Node no longer copies stream bytes.

Immutable physical-account mapping reads use a read-only consistent snapshot.
They do not take the consumer's exclusive mutation lock twice on every public
request. Current dispatch authorization and all actual management writes retain
their existing durable fences and mutation locks.

The Go public listener is disabled unless protected native bootstrap specifies
both `publicListenAddress` and `publicMaxActive`. The address must be a separate
loopback listener; the active-request limit is 1 through 2048. Public socket
headroom is finite at `2 × publicMaxActive + 128`, independently of private
control sockets. An edge may expose one external TLS origin and route inference
and control to their respective internal listeners. Client input cannot select
a provider or private native URL.

The execution SDK accepts separate `origin` and `inferenceOrigin`. Omission of
`inferenceOrigin` preserves existing routing. Standard Responses and native
Anthropic Messages clients use an execution capability issued by the control
plane; no private native credential or upstream provider credential is exposed.
Messages preserves the native protocol, including the literal `?beta=true`
route used by Claude Code.

Protected service profiles accept an explicitly qualified per-account concurrency
ceiling of 1 through 64. A bearer cannot raise that ceiling. The default remains
one; 64 is an operator bound, not a provider-account entitlement. An absent
profile in an explicit capacity map receives no capacity.

Keep protected HMAC keys stable across restarts. Authenticated execution
capabilities can be reconstructed without an accumulating process-local bearer
registry, but current durable authority is revalidated. Changing an already
configured key is rejected. Issuer and policy changes do not silently preserve
obsolete execution authority.

Public terminal `response.completed` and `message_stop` frames are withheld
until the terminal effect, configured usage and exact physical closure ACK are
durable. Finalization uses a separate bounded callback lane, with per-frame and
aggregate held-terminal memory limits. Settlement failure retains original
evidence and prevents a false successful terminal. Before a claim, capacity
refusal is explicitly `admission_limited` / `not_dispatched`; authentication and
protocol errors cannot count as successful overload handling.

An authenticated private public-admit callback refused by the finite gate before
its work starts returns a purpose-specific `claim=not_started` receipt bound to
Go's original reservation nonce. Only this strictly validated receipt permits
Go to report a safe pre-claim capacity refusal and discard its unentered local
reservation. A generic 503, lost callback reply, malformed or mismatched receipt,
or failure after admission work starts remains ambiguous and retained.

### Migration and retention rollout

Stop every old kernel writer before migration 009: old global-budget-before-
consumer locks and the new consumer/account-before-budget order must not coexist.
Apply migrations in order through 012 before starting new writers. Historical
migration checksums remain unchanged.

When the runtime role differs from the migration owner, grant that specific role
execution on `ag_kernel.open_consumer(text,bigint,bigint,bigint,integer,integer)`
and `ag_kernel.retire_closed_request_details(text,integer)`. Their default PUBLIC
execution privilege is revoked; retain existing restricted table/schema grants
instead of adding a broad PUBLIC grant.

`requestReadbackRetentionMs` is optional, from 1 millisecond through 365 days,
and is captured on each newly prepared execution. Omission disables detail
retirement for that execution. Reclamation waits until the horizon has elapsed
after both logical closure and completed physical cleanup, and requires positive
settled effects, exact ACKs and v2 namespace-bound native reservations.

Migrations 011–012 bound both selected namespaces and removed request rows by the
maintenance batch. It marks the namespace irrevocably retired before deleting
request details and usage revisions, refunds only deleted request units, and
excludes fully drained namespaces from future maintenance scans. Detail readback
then becomes unknown; the permanent execution fence prevents replay.

Migration 012 selects the eligible batch once. With 10,000 empty closed/done
namespaces and batch 100 on disposable PostgreSQL 17.10, repeated-selection 011
held the consumer transaction for 2,377/2,247 ms; an otherwise identical
once-selected prototype took 42/60 ms and retired the same 100 namespaces with
zero refund. These are local maintenance measurements, not throughput promises.
The physical eligibility scan can still examine the candidate set once per turn.
The complete kernel regression suite passed 59/59 tests on both Node versions
after the migration, including empty, partially drained and multi-account cases.

Execution/prepare, account, candidate, operation and issuer tombstones retain
finite budgets. Legacy random-nonce requests, unknown effects and occupied
transports remain retained. This is neither unlimited execution-creation churn
nor an unlimited billing-history store. Choose the readback horizon to match
audit needs before enabling it.

The qualified topology has one composed owner of the native process and its
protected authority directory. Multi-replica native ownership and horizontal
deployment safety are not established by these changes.

## Reproducible qualification matrix

[Full-stack CI](../../.github/workflows/fullstack-load.yaml) provisions exact
dependencies before measurement and runs the actual service, SDK, native binary,
PostgreSQL and controlled TLS provider without external container networking.

| Profile | Resource bound | Required evidence |
| --- | --- | --- |
| Baseline, Node 26 and 24 | 2 CPU, 4 GiB, 4096 descriptors | Slow reader, disconnect, close, overload recovery, 130 new execution capabilities beyond the old 128 registry limit |
| Streams, Node 26 | 2 CPU, 4 GiB, 16384 descriptors | Exactly 64/256/512/1024 occupied streams; 1024 held for at least 60 seconds with control progress; simultaneous completion and durable settlement |
| Arrivals, Node 26 | 2 CPU, 4 GiB, 16384 descriptors | Two-second offers at target 50/100/250/500/1000 requests per second; actual launch rate, lag, completions and safe refusals |
| Sustained arrivals, Node 26 | 2 CPU, 4 GiB, 16384 descriptors | 3000 offers at target 50 requests per second over one minute; ten-second completion/refusal/launch-lag windows, control progress and exact final cleanup |
| Large context, Node 26 | 2 CPU, 4 GiB, 4096 descriptors | Approximately 1 MB synthetic input at 1/8/32/64 synchronized offers; actual completions and safe refusals |

Manual `smoke` runs only the two smoke Node lanes with accurate artifact names.
The default selection requires both complete baseline lanes and all four scale
profiles. Every attempted request is reconciled with the controlled-provider
entry ledger, SQL effect and exact native closure/ACK. Duplicate entry, unexpected
authentication failure, ambiguity, a broken successful-client stream, occupied
rows after drain or missing closure evidence fails the gate. No paid-request
replay repairs a failed workload.

The first expanded run, [39981661848](https://github.com/agent-teams-ai/account-gateway/actions/runs/39981661848),
passed both complete baseline lanes and the large-context profile. Each baseline
had 446 attempts, 197 issued capabilities, all 130 churn executions, exact ledger
agreement and zero final occupied/unresolved-cleanup rows. Large-context offers
1/8/32/64 completed 1/8/28/30 requests and safely refused 0/0/4/34. The two scale
containers did not start because their initial 4-CPU request exceeded the
runner's actual 2 CPUs. This is preserved as infrastructure failure and provides
no scale-capacity evidence. The matrix now explicitly uses 2 CPU and 4 GiB.
Those first receipts identify merge checkout `57b55498117faaa1223923f29baa486862e995c4`
for PR head `0bf0b1481e5a1e74722d73a2799de37446327c37`, with native
`2ca8d7bd5a7646416580eda397b7ec50c0e12055`.

The corrected two-CPU run, [39983757108](https://github.com/agent-teams-ai/account-gateway/actions/runs/39983757108),
passed both baseline lanes and the stream profile at 64/256/512/1024 concurrent
streams, with all 1856 requests completed and exactly one provider entry each.
The 1024 level took 32.791 seconds to admit, held exactly 1024 occupied transports
for 60.004 seconds, and completed its simultaneous release in 9.973 seconds.
Control latency during that hold was at most 26 ms. Final occupied and unresolved
cleanup counts were zero, all 32 executions closed and PostgreSQL stopped.
Sampled Node and Go peaks were 433,332,224 and 253,444,096 bytes respectively;
first-byte p50/p95/p99 were 81/109/138 ms. Those latency percentiles cover paced
admission; completed latency includes the deliberate stream hold and is not an
ordinary provider-response benchmark. The ten-second per-finalizer deadline
includes its four-slot queue wait. The aggregate release duration does not expose
individual finalizer margin; this run establishes successful closure, not robust
headroom for a larger or more variable simultaneous terminal burst.

That same run failed the first arrival level after 100 offers: 54 completed,
40 were safely refused and six received ambiguous 202 responses despite no SQL
claim or provider entry. Large context similarly stopped after 41 offers. The
private callback gate returned an undifferentiated 503 before work, so Go could
not prove a no-claim outcome. The nonce-bound pre-work receipt fixes that specific
boundary while preserving conservative ambiguity after work may have begun.
These failures remain recorded; they establish no higher arrival-rate capacity.
This run used merge checkout `bb09c6e79617c92b1286f43b659bc2feaf2faf82` for PR head
`d371dc530e9fb4420c0d616890c6c3e9676927e5` and native
`2ca8d7bd5a7646416580eda397b7ec50c0e12055`.

The stream profile paces admission to isolate live-stream capacity. At 1024 total
streams across 32 accounts it tests 32 live streams per account; 64 is the configured
ceiling. The arrival profile distinguishes offered and accepted rate: a nominal
1000-per-second target is not measured completion capacity. Large-context input
measures synthetic byte transport and validation, not model tokenization/compute.
The sustained profile requires positive validated terminal completions inside
every actual ten-second wall interval, as well as eventual positive completions
for each offered cohort, and separately reports safe refusals and launch lag.
It measures one minute of continuous
arrival processing; it is not a multi-hour soak, a zero-refusal 50-rps SLO or an
unlimited execution-retention claim.

Node resource samples include the load driver and TypeScript service in one
process. Go samples identify the exact native PID and birth. Provider/PostgreSQL
RSS are not separately sampled; the container memory limit bounds the whole job.
Receipts include event-loop delay, SQL waits, occupancy and completion latency.
The 4096-entry fixture does not force receipt eviction; the independent cap-two
unit regression proves authenticated closed/acknowledged eviction.

[Pinned client CI](../../.github/workflows/native-client-qualification.yaml)
adds race-checked public ingress/bootstrap, real PostgreSQL Claude lifecycle and
SQL-guard regressions, and real Codex 0.164.0 and Claude Code 2.1.309 processes.
Official archives and binaries are integrity-pinned in
`services/account-gateway/test/fixtures/native-cli/pins.json`; installation runs
no package scripts. The fixture requires both named client passes, zero skips,
fresh databases, loopback-only networking, no routes, a failed external probe,
and positive PostgreSQL shutdown. Exported test evidence excludes arbitrary
assertion values, credentials and provider bodies, including on failure.

Actual-client tests cover CLI protocol, real native OAuth account identity,
native usage SQL, TLS and terminal ACK. Their metadata authority is a fixture
and their upstream is controlled loopback TLS. The full-stack load fixture
separately covers the joined TypeScript kernel and native process. These are
not live-provider quota acceptance or a complete real-CLI-through-real-
TypeScript-OAuth deployment test.

The Codex fixture uses an explicit Responses HTTP/SSE provider configuration,
`supports_websockets=false`, and zero request/stream retries. WebSocket inference
is outside this listener's contract. Claude Code runs one turn with tools disabled
and a fresh isolated configuration. The process checks establish supported
transport and terminal behavior, not arbitrary interactive/tool workflows or
third-party client retry policies.
