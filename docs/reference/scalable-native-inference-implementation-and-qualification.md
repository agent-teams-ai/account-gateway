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
pins native `a6bc1e36a1cd0d542af2806f3f8ae1e098e7cc76`; each CI receipt records the
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

## Evidence and qualification authority

[Account-gateway PR 71](https://github.com/agent-teams-ai/account-gateway/pull/71)
and [native PR 64](https://github.com/agent-teams-ai/sub2api/pull/64) publish the
current source pins, exact workflow receipt links, per-lane conclusions and
sanitized evidence. Consult those source-pinned receipts for the current
qualification status. A successful package, kernel or client run qualifies its
recorded scope; it does not establish a different load profile or production
capacity. This reference does not assume that an in-progress or later source
revision has passed.

The native pre-claim queue/active budget repair is implemented in
`5a8b8a6f0d2e495891897097ec1770bff5b7cc6b`. The required public-ingress allowlist
has 23 names, including three regressions for separate queue/active budgets,
cancellation before POST and ambiguous active attempts, plus exact requested-model
metadata bound to the original reservation and alternate OpenRouter catalog
selection with exact settlement. Current-source qualification must
require all 23 public tests and all three bootstrap tests, including the public
connection policy; earlier 18/21-public and two-bootstrap receipts qualify only
the source revisions they record.

### Pre-integration transport finding: gateway bb0d5b7 / native 5a8b8a6

[Client qualification 40561199655](https://github.com/agent-teams-ai/account-gateway/actions/runs/40561199655)
passed both runtime lanes at gateway head `bb0d5b732a5618ba97c88f7c4c988cf6b152f83d`.
[Load qualification 40561199620](https://github.com/agent-teams-ai/account-gateway/actions/runs/40561199620)
passed both baseline lanes, large context, arrival overload and sustained arrivals,
but failed the stream profile. It stopped after 108 attempts: 107 entered the
provider and completed, while one failed at the SDK transport boundary after
three milliseconds without a SQL row or provider entry. Every entered request
had exact closure and ACK; final open, occupied and unresolved cleanup counts
were zero. The aggregate load qualification still failed.

The working diagnosis was reuse of an idle public HTTP connection racing the
server's one-second idle timeout. The receipt does not expose a socket-level
cause, so that diagnosis remains an inference. The repair makes the public
server's no-reuse policy explicit and adds a production-constructor regression.
It neither retries inference nor reclassifies a transport error as safe overload.
Fresh source-pinned qualification must cover the integrated code and this repair.

### Integrated receipts: gateway be5c65e / native 63a7eb1

[Client qualification 40565984202](https://github.com/agent-teams-ai/account-gateway/actions/runs/40565984202)
passed both Node lanes on gateway head `be5c65e203cde4093a5e7369b3fbbfddf22255f8`
and tested merge `7549caa3b756f86d3fc0a505c24c08aed8413d5e`. Both real Codex and
Claude Code completed through the TypeScript authority, Go engine and PostgreSQL.
Codex selected `gpt-5.4` from the authenticated catalog; provisional and final
usage retained that exact requested model. Each lane passed all 22 public,
14 reservation and three bootstrap tests, both PostgreSQL regressions, and both
standalone and joined actual-client cases without skips.

[Load qualification 40565984190](https://github.com/agent-teams-ai/account-gateway/actions/runs/40565984190)
passed both baseline lanes, 1,856 completed streams across the 64/256/512/1,024
ladder, 3,000 completed offers over one minute, and all 105 large-context offers.
The burst profile failed at the 500-offers-per-second step: one attempt became
an unintentional unknown effect after 281 milliseconds, with zero provider
ledger entries. Its execution was fenced, and 31 later offers on that execution
were denied. The profile stopped before the 1,000-offer step. All entered
requests had exact acknowledged closure and final open/occupied/unresolved
counts were zero; those cleanup results do not make the failed profile pass.

The original receipt omitted native entered/completed observations and discarded
sanitized transport diagnostics. Zero provider ledger entries therefore did not
prove native non-entry or identify a socket-level cause. The current fixture
retains entered/completed/effect only when bound to the original full native
proof and retains at most eight strictly reconstructed response-failure records
in failed operator evidence. Diagnostics contain fixed error categories and
connection/write/response flags, without error text, addresses, credentials or
provider bodies. Trace flags describe observations available at failure time;
a false write flag is not proof that no bytes were sent.

The required upstream race gate exercises real TLS response bounds and a stale
HTTP/1 connection closed at reuse, requiring one original provider entry and no
replay after ambiguity. The diagnostic race gate checks fixed classification,
trace composition and privacy. This demonstrates a relevant transport failure
mechanism; it does not retroactively establish the cause of the earlier burst
failure. The source-pinned current CI receipts remain the qualification authority.

The next instrumented [full-stack run 40569498843](https://github.com/agent-teams-ai/account-gateway/actions/runs/40569498843)
passed all six profiles at gateway `34586c6` and native `fe0862b6`.
[Client qualification 40569498972](https://github.com/agent-teams-ai/account-gateway/actions/runs/40569498972)
passed both upstream TLS regressions but caught a diagnostic classification bug:
an outer URL error could hide a nested typed network timeout. The classifier now
walks bounded wrapped/joined causes without reading error text. Its regression
remains required; current source still requires a complete fresh client/load run.

### Historical pre-repair receipts: gateway f9b1a57 / native 6545944

The following completed receipts are for gateway head
`f9b1a57b6f56f17d81a27c1d7ff16936119f59b5` and native
`654594451d1951f2f85c2d3e4011b000a9e68bdd`:

- [Package qualification 39992708441](https://github.com/agent-teams-ai/account-gateway/actions/runs/39992708441) passed.
- [Kernel qualification 39992708492](https://github.com/agent-teams-ai/account-gateway/actions/runs/39992708492) passed.
- [Pinned client qualification 39992708440](https://github.com/agent-teams-ai/account-gateway/actions/runs/39992708440) passed on Node 26.11.1 and 24.21.0.
- [Full-stack qualification 39992708669](https://github.com/agent-teams-ai/account-gateway/actions/runs/39992708669) failed overall: both complete baseline lanes, large context and the stream ladder passed; arrivals and sustained arrivals failed.

Each pinned-client Node lane passed all 18 then-required public-ingress tests,
14 private reservation/closure tests, two bootstrap race tests, two Claude
PostgreSQL regressions, two actual CLI protocol tests and two actual CLI tests
joined to the real TypeScript authority. There were no skips. Each joined client
made exactly one controlled-provider entry through the real TypeScript
management, kernel, usage and cleanup path, Go OAuth transport and native
PostgreSQL. Blocking the real usage append prevented CLI completion; releasing
it produced the unchanged original ownership proof, durable usage and physical
closure ACK, zero occupied rows and completed execution cleanup. Networking was
loopback-only with no external egress, and PostgreSQL positively stopped.

The 18-test count above belongs to the completed `f9b1a57` receipt and does not
qualify the three new tests or the implemented budget repair. This historical
full-stack run used merge checkout
`22d225593ff33bf3ffbff640d3af2035cf7a707c` with native
`654594451d1951f2f85c2d3e4011b000a9e68bdd`. Its exact stream and failed arrival
measurements are recorded below as pre-repair evidence. These measurements are
not a current-source capacity promise.

Earlier complete package and kernel qualification passed for gateway
`d371dc530e9fb4420c0d616890c6c3e9676927e5`:

- [Package qualification 39983757117](https://github.com/agent-teams-ai/account-gateway/actions/runs/39983757117)
- [Kernel qualification 39983757119](https://github.com/agent-teams-ai/account-gateway/actions/runs/39983757119)

Those historical disposable PostgreSQL checks passed 59 kernel tests and 74
OAuth enrollment tests on each required Node version, without skips. The earlier
[client workflow 39983757364](https://github.com/agent-teams-ai/account-gateway/actions/runs/39983757364)
passed its then-required 11 public-ingress tests, two bootstrap race tests, both
Claude PostgreSQL regressions and both actual client processes on both Node
versions, with no skips, no external network, sanitized evidence and positive
PostgreSQL shutdown. Historical successful profiles remain tied to their source
revisions and workload shapes. Only successful receipts establish their
corresponding load qualification; source review does not imply production
capacity.

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

The public HTTP listener closes each connection after its response completes.
It explicitly disables HTTP keepalive reuse so a client cannot race a short
server idle timeout by reusing a connection for another inference. An active
SSE response keeps its connection through terminal settlement and delivery; the
private control listener keeps its existing connection policy. The production
server constructor is covered by a required real-HTTP bootstrap regression.
This trades connection reuse for a definite public transport lifetime and does
not add retries after an ambiguous request.

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
aggregate held-terminal memory limits. Its four callback owners have a finite
20-second queue wait and a fresh 10-second active settlement budget; each wire
callback remains bounded by the existing five-second timeout. Waiting consumes
no SQL checkout or callback socket, and the public-handler bound limits waiters.
The terminal write receives one fresh I/O deadline only after physical completion
and durable ACK. This does not extend provider execution or allow replay.
Settlement failure retains original
evidence and prevents a false successful terminal. Before a claim, capacity
refusal is explicitly `admission_limited` / `not_dispatched`; authentication and
protocol errors cannot count as successful overload handling.

An authenticated private public-admit callback refused by the finite gate before
its work starts returns a purpose-specific `claim=not_started` receipt bound to
Go's original reservation nonce. Only this strictly validated receipt permits
Go to report a safe pre-claim capacity refusal and discard its unentered local
reservation. A generic 503, lost callback reply, malformed or mismatched receipt,
or failure after admission work starts remains ambiguous and retained.

Pre-claim metadata has a separate finite callback lane from dispatch, owner and
cleanup checks for already accepted work. Go bounds pre-claim callback producers
before they open callback sockets. The implemented correction gives each
authority and claim callback a bounded five-second queue wait, then a fresh
five-second active RPC budget after acquiring one of the same four producer
slots. The original caller's cancellation and earlier deadline still apply.
Queue expiry or cancellation before acquisition must never send a POST; timeout
or cancellation after an active attempt retains its conservative ambiguity and
cannot authorize replay. The independent terminal lane is unchanged. Current
qualification receipts are published on PR 71 and PR 64; the historical
`f9b1a57` receipts above used the earlier shared queue/active deadline.

Structurally exact SQL ownership evidence is retained before subsequent live
dispatch verification; retaining proof does not grant dispatch permission. If
that later check fails, the original proof remains available for independent
no-entry settlement and exact closure acknowledgment.

### Exact requested-model attribution

The canonical account descriptor identifies its qualified provider profile.
For qualified dynamic Codex and OpenRouter catalog selection, its model anchor
can differ from the model
selected for a particular request. Public claim and settlement metadata therefore
carry a bounded `requestedModel` scalar captured from the qualified payload on
the first native reservation. Duplicate requests cannot replace it, and neither
prompt nor output bodies enter these callbacks. The usage journal records the
requested model in its provisional and final revisions; an inconsistent later
model cannot authorize terminal acknowledgment. Native account-scoped catalog
checks remain the dispatch authority. Carrying a model identifier grants no new
permission and does not trigger pre-claim catalog I/O in TypeScript.

The actual Codex joined E2E selects an alternate model from its controlled account
catalog and checks the resulting PostgreSQL usage alongside the existing durable
terminal, original-proof and cleanup assertions. Its source-pinned receipt must
pass before this integrated revision is qualified.

### Early collection rejection

The runtime dependency is pinned to [Zod 4.6.7](https://github.com/colinhacks/zod/releases/tag/v4.6.7).
Collection upper limits must reject oversized input before validating its
elements or accumulating an issue for every invalid element. Earlier Zod
versions could apply `.max()` only after traversing the collection; the
[upstream fix](https://github.com/colinhacks/zod/commit/a0ebf970f2d752e5f58527cd2942ff48be4f46bd)
adds early leading size checks, addressing
[GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).
The boundary regression requires rejection before element validation. Request
byte limits and authentication remain independent controls: an authorized body
within its byte limit can still contain many invalid elements, so neither
bounds the validation work of a late array-length check. Keep the early
collection cap when evolving the shared wire schema.

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
ordinary provider-response benchmark. That revision's ten-second per-finalizer deadline
included its four-slot queue wait. The aggregate release duration does not expose
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

The subsequent [39987501598 run](https://github.com/agent-teams-ai/account-gateway/actions/runs/39987501598)
at gateway head `98bb5f523f11a6b4fdf01b95dd85c2993e8774cd` and native
`b48f89102e0ed8375cdc1838d2701718aae76bb1` exposed two additional limits. New
pre-claim offers could saturate callbacks needed to verify accepted claims; an
exact claim proof was retained too late to settle the resulting no-entry attempt.
Separate callback purposes and earlier retention of structurally exact proof
address that path without granting dispatch permission or weakening ambiguity.

The same run reached all 1856 controlled provider entries in the stream ladder,
but 353 client streams failed terminal delivery. All had exact proof and positive
physical native closure without acknowledgment; their provider-end-to-client
failure durations clustered at 10.030–10.197 seconds. Successful deliveries ended
by 9.929 seconds. Sustained arrivals independently showed the same ten-second
cutoff. This is failed qualification, not successful overload handling. The
measured queue-aging defect is why finalization now gives finite queue waiting
and active settlement separate budgets. Its four owners, SQL limits, terminal
durability checks and no-replay rule are unchanged. The subsequent source-pinned
receipts below qualify that correction for the successful profiles they name;
the failed arrival profiles remain unqualified.

### Historical pre-repair full-stack measurements: run 39992708669

[Run 39992708669](https://github.com/agent-teams-ai/account-gateway/actions/runs/39992708669)
tested merge checkout `22d225593ff33bf3ffbff640d3af2035cf7a707c` for gateway head
`f9b1a57b6f56f17d81a27c1d7ff16936119f59b5`, native
`654594451d1951f2f85c2d3e4011b000a9e68bdd`, and 2 CPU / 4 GiB per container.
Both complete baseline lanes, large context and streams passed. Arrivals and
sustained arrivals failed, so the aggregate workflow failed.

The stream ladder completed all 64/256/512/1024 levels: 1856 controlled-provider
entries and 1856 validated completions, exactly one entry per original request,
no reconciliation faults and exact ledger agreement. All 32 executions closed;
final open, occupied and unresolved-cleanup counts were zero, cleanup retired
and PostgreSQL stopped. The 1024 level admitted in 31.689 seconds, held exactly
1024 occupied streams for 60.007 seconds and completed its simultaneous release
in 10.506 seconds. Control progress during the hold took at most 4 ms.
First-byte p50/p95/p99 were 75/104/133 ms during paced admission. Sampled peak RSS
was 460,595,200 bytes for the combined load driver and TypeScript process and
256,974,848 bytes for Go.

These streams used small SSE output with one-second keepalives. Total consumer
bytes were 6,514,922 across the whole ladder. The result establishes this
controlled one-minute hold and completion burst; it does not qualify heavy
output, long contexts at this concurrency or a multi-hour soak. The finalizer
queue and active budget separation passed this workload, without implying
headroom for an arbitrary larger or more variable terminal burst.

The arrival profile reached the following levels before stopping at the failed
250-per-second step:

| Target offers/second | Offers | Validated completions | SQL-dispatched attempts with no provider entry | Outcomes without a SQL row | Safe rejections |
| --- | --- | --- | --- | --- | --- |
| 50 | 100 | 100 | 0 | 0 | 0 |
| 100 | 200 | 200 | 0 | 0 | 0 |
| 250 | 500 | 186 | 99 | 210 | 5 |
| Total | 800 | 486 | 99 | 210 | 5 |

Final arrival occupancy was seven rows, with six unresolved-cleanup rows.
The 500- and 1000-per-second levels were not reached and have no qualification
from this run. The sustained profile offered 3000 requests: 1955 entered the
controlled provider and completed, 495 were SQL-dispatched without provider
entry, 449 had no SQL row and 101 were safely rejected. It ended with 437
occupied rows and 32 unresolved-cleanup rows. Neither failed profile establishes
successful overload recovery or sustained 50-per-second capacity.

The working diagnosis is that the pre-claim callback's five-second deadline
included its wait for one of four producer slots, leaving an exhausted or short
active budget under saturation. The receipts expose SQL/provider-entry outcomes
but do not instrument the precise deadline-expiry instant, so exact expiry is an
inference from the pre-repair implementation and observed failures. The repair
implemented in native `5a8b8a6f0d2e495891897097ec1770bff5b7cc6b` separates a
five-second queue wait from a fresh five-second active budget while preserving
the original caller, the same four slots and no replay after an ambiguous POST.
Its three new required public regressions raise the allowlist from 18 to 21.
Use the exact current-source workflow receipts published on PR 71 and PR 64 to
assess the repaired load shapes; these historical failures and passing stream
measurements do not qualify the repair.

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
The reservation race lane also requires every original registry regression and
the actual private HTTP closure suite, covering the private path shared by proof
retention changes.
Official archives and binaries are integrity-pinned in
`services/account-gateway/test/fixtures/native-cli/pins.json`; installation runs
no package scripts. The fixture requires both named client passes, zero skips,
fresh databases, loopback-only networking, no routes, a failed external probe,
and positive PostgreSQL shutdown. Exported test evidence excludes arbitrary
assertion values, credentials and provider bodies, including on failure.

The protocol-focused actual-client tests cover real native OAuth account
identity, native usage SQL, TLS and terminal ACK using a fixture metadata
authority. A second required lane joins each actual client to the real TypeScript
management, execution capability, kernel, usage journal and native authority,
then the real Go OAuth transport, PostgreSQL and controlled loopback TLS provider.
Claude uses the browser OAuth enrollment flow and Codex uses device enrollment.
Both execute exactly one inference and close their original execution.

The joined lane deliberately blocks the real terminal usage append. During the
block, SQL has the completed effect but retains transport occupancy and lacks
its closure ACK; the actual CLI must not report success or exit. Releasing the
append must produce complete usage, the unchanged original ownership proof,
physical native closure and ACK before client success, followed by completed
execution cleanup. No callback or usage authority is substituted in this lane.
Build and runtime receipts bind both source commits, fixture and runtime source
hashes, the exact Go binaries and pinned CLI binaries. The runner requires
loopback-only networking and positive PostgreSQL shutdown, and exports only a
fixed proof projection, including on failure. These checks do not establish
live-provider quota acceptance or production deployment capacity.

The Codex fixture uses an explicit Responses HTTP/SSE provider configuration,
`supports_websockets=false`, and zero request/stream retries. WebSocket inference
is outside this listener's contract. Claude Code runs one turn with tools disabled
and a fresh isolated configuration. The process checks establish supported
transport and terminal behavior, not arbitrary interactive/tool workflows or
third-party client retry policies.
