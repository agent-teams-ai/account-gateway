---
id: docs.reference.cloud-load-qualification
type: reference
status: proposed
owner: gateway-maintainers
summary: Bounded production-service E2E and load fixtures, control progress fixes, and reproducible qualification evidence.
---

# Cloud load qualification

## Overview

This qualification exercises the public SDK and HTTP boundary, the production
`startService` composition, the production Go `cmd/account-gateway` executable,
and two fresh PostgreSQL databases. A separate controlled TLS provider records
each actual request in an append-only ledger. No real provider credential or
external provider connection is used.

The implementation is in `services/account-gateway/test/load`. It is a fresh
implementation after an earlier uncommitted workspace was lost. Its receipts
describe only executions produced by this implementation; historical reports
are not imported as passing evidence.

The workflow [Production full-stack E2E and bounded load](../../.github/workflows/fullstack-load.yaml)
runs all eight scenarios on every pull request for both Node runtimes. Its `workflow_dispatch`
input selects smoke or all eight scenarios. Missing prerequisites, missing
scenarios, an inconclusive backpressure experiment, a nonzero test exit, or an
unreconciled effect fail the job. The operator never converts these into skips.

### Qualified inputs

| Input | Pin or condition |
| --- | --- |
| Default Node | 26.11.1 |
| Compatibility Node | 24.21.0 |
| Package manager | pnpm 11.28.2, frozen lockfile and strict engines |
| Go | 1.27.3; `CGO_ENABLED=0`, Linux amd64, `-mod=readonly -trimpath` |
| Native source | `agent-teams-ai/sub2api@b813197871c3d7a2ae07fa9cabe97b9862856653` |
| Native target | `backend/cmd/account-gateway` |
| PostgreSQL | 17.10; native production migrations and all gateway migrations |
| CI PostgreSQL image | `postgres:17.10@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317` |
| CI runtime additions | Debian trixie `libatomic1=14.2.0-19` and `ca-certificates=20250419+deb13u1` |
| Measured network | Loopback only, no IPv4 routes, external probe returns `ENETUNREACH` |
| Bounded TCP profile | Private namespace `tcp_rmem` and `tcp_wmem`: `4096 16384 65536`; `tcp_moderate_rcvbuf`: `0` |

`build-native-fixture.ts` verifies a clean native checkout and its exact commit,
builds the production executable, then generates a temporary Go adapter that
calls the native repository's production `ApplyMigrations`. The adapter checks
every applied migration checksum and emits a source migration digest. It does
not serve requests or replace the native runtime. Its temporary source is
removed, and the checkout must remain clean. The build receipt binds both
executables and the embedded adapter source by SHA-256.

The workflow derives its runtime image from the pinned PostgreSQL image and
installs only the explicitly versioned [libatomic1](https://packages.debian.org/trixie/libatomic1)
and [CA bundle](https://packages.debian.org/trixie/ca-certificates) packages before
measurement. The base image lacks both Node 26's `libatomic.so.1` dependency and
the CA bundle used by the fixture's trust setup. A separate network-disabled
preflight starts the selected Node runtime and checks OpenSSL, PostgreSQL and
the CA bundle. After dependency installation, another network-disabled check
imports the actual built SDK and service composition inside that same image.
Both checks run before the expensive native build. Package installation is not
part of the measured workload.

The explicit TCP profile makes upstream backpressure observable before the
8-MiB output bound. Default autotuned receive buffers can exceed the entire
fixture output, producing an inconclusive slow-reader experiment. The workflow
sets these values only in its disposable container's network namespace; the
operator records the actual readbacks and requires this profile for `all` and
`slow-reader`. Host TCP settings remain unchanged. Focused non-backpressure
scenarios can use the recorded environment defaults.

The service drops the Go process to UID/GID 65534. Its executable is in a
root-owned directory with traversable ancestors; configuration, synthetic
credentials and private TLS material remain in separate mode-0700 directories.
The operator explicitly makes its private executable copies root-owned because
file copying preserves the build runner's source ownership.
The disposable container uses normal TLS verification with its own fixture CA.
The operator supports only the supplied disposable Docker recipe. Its default
trust mode is `container`; the previous standalone `bind` mode is rejected before
provisioning. The container marker is a misuse guard, not proof that arbitrary
repository code is sandboxed. The external Docker invocation provides isolation:
no external network or privileged mode, read-only source/build mounts, and only
the fresh artifact directory writable on the host.

The workflow creates a fresh root-owned mode-0700 artifact destination before
the operator runs. The operator rejects a destination with another owner,
broader permissions, existing entries, or a symlink as its final component.
It pins the directory with an open file descriptor before provisioning and
exports only the ten allowlisted evidence files through exclusive, no-follow
file opens relative to that descriptor. Bytes and mode-0600 permissions are
written through the resulting file descriptors. Replacing the destination or
an ancestor cannot redirect an export; a preexisting file or symlink fails
without overwriting or changing its target's permissions. Exported files must
be regular, single-link files, bounded to 64 MiB in total. Raw private logs and
fixture credentials are not exported.

The operator stops its fresh PostgreSQL instance with a bounded fast shutdown,
checks that the original data directory has no running postmaster, and attempts
a bounded immediate shutdown if the stop is unconfirmed. A failed shutdown keeps
the qualification failed even when the fallback succeeds. Unconfirmed shutdown
preserves the data directory and records its location; the operator never deletes
the data of a postmaster it cannot confirm has stopped.

## Production fixes

The public facade and native callbacks previously competed for the same control
admission path and too few callback sockets. Native management and transport
control requests also entered the Go listener without one shared finite queue.
Under load these relationships could prevent the control work needed to release
occupied data requests from progressing.

The service now has a separate authenticated native callback admission gate:
eight active callbacks and 22 waiting callbacks, with a finite socket allowance
of 38 for callback, enrollment and usage traffic. Callback work retains its
permit until the work settles, even after a caller disconnects. It uses the
existing reserved SQL control lane.

All service-owned native control clients share one FIFO admission queue: six
active requests and 24 waiting requests, leaving two native control slots for
direct control traffic. A request's existing deadline covers both waiting and
wire time. Cancellation, queue overflow and expiry before admission perform no
HTTP request. The active permit is retained through physical socket closure.
There is no inference retry or failover.

Pressure qualification also reproduced a completed provider response whose HTTP
stream lost EOF: after native completion and acknowledgement, the facade's
terminal SQL read still competed with new data admission. Trusted native
preparation, original proof recovery, first-byte status and terminal stream
readback now use the reserved control SQL lane. Initial public grant/body
validation remains in the data lane. No SQL checkout is retained across a native
HTTP wait, and exceptions still preserve ambiguous effects. A real HTTP and
PostgreSQL regression holds all six data clients and eight SQL waiters while
verifying native preparation, completion, acknowledgement and successful client
EOF through the control reserve.

The slow-reader run also exposed a valid stream being canceled on Node 24:
HTTP iterator reads coalesced above 64 KiB, exceeding the facade's per-chunk
bound even though the complete response remained within its approved limit.
The native adapter now delivers ordered copies of at most 64 KiB on demand and
checks cancellation between slices. The facade bound, aggregate output limit,
first-byte effect transition and exact EOF/closure checks remain in force.
The same slow-reader workload and its backpressure oracle qualify this fix.

Cleanup previously attempted one durable job per cleanup turn. A successful
turn now settles at most eight jobs and stops starting new work after one
second. The first unresolved job ends that turn. OAuth still receives the next
maintenance tick; every acquired cleanup claim retains its existing lease and
closure rules. Unknown accepted effects and occupied transports are not cleared
without proof from the original native claim.

The existing limits remain: 16 active data requests, eight active facade control
requests, eight waiters in each SQL checkout lane, eight PostgreSQL connections
with two reserved for control, one concurrent request per account, and 128 live
bearers including the two configured fixture bearers. The facade admits or
refuses immediately; SQL and native control have separate finite queues.

These limits form several admission stages. Six data SQL connections plus eight
SQL waiters can refuse the last two requests in a synchronized 16-request burst
before any provider entry. The active HTTP limit is an upper bound, not a promise
that every simultaneous arrival is accepted. To test all 16 occupied streaming
slots, the overload scenario paces its 16 distinct initial requests until each
actually enters the provider, then sends the excess burst. It never retries an
inference to fill those slots.

## Contract

### Workload and acceptance

| Scenario | Workload | Required evidence |
| --- | --- | --- |
| `smoke` | Two SDK requests in the same open execution | Valid SSE content and usage, one provider entry per request, exact acknowledged native closure |
| `short-steps` | Concurrency 1, 2, 4, 8, 16, 24, 32; provider delay 75 ms | All requests complete through eight-way bursts; larger bursts complete at least eight and otherwise have explicit safe zero-entry denials; no duplicate provider entries |
| `long-steps` | Concurrency 1, 4, 8, 16, 24; provider delay 1.5 s | Same layered admission checks with held streams and exact original closure proofs |
| `arrivals` | 1, 4, 8, 16, 32 offered requests/s, two seconds per rate | Accepted effects reconciled; all 32 original executions closed and cleaned; 32 fresh executions prepared |
| `slow-reader` | Raw TCP reader pauses after first response data, then resumes | An upstream write remains blocked at least 200 ms and subsequently drains; absence of that observation is inconclusive and fails qualification |
| `cancellation` | TCP disconnect and SDK abort after real provider entry; duplicate original request readback | Unknown effect preserved, original transport physically closed and acknowledged, duplicate cannot dispatch again |
| `overload-recovery` | 16 provider streams held; 32 excess requests; eight concurrent SDK execution closes | Zero excess provider entries, protected control progresses, real cleanup completes, remaining eight streams complete, a fresh request succeeds without restart |
| `bearer-cap` | Fill the unchanged registry to two configured plus 126 execution bearers; four extra preparations | Explicit safe issuance refusals, original bearer preserved, every newly issued bearer exercised, denied executions have no request effects and are fenced through SDK authority |

The overload scenario's SDK close operation durably queues cleanup; the public
close response does not itself await the native callback. The separate actual
HTTP regression test deliberately holds eight facade owners awaiting callback
work and verifies independent callback progress. These are distinct contracts.

Only the standalone smoke provisions one account. All other runs use 32 accounts
because concurrency is account-wide. Reusing one account would test the account
limit instead of the service's 16 active data slots. Request identities include
a fresh run UUID, explicit seed and monotonic sequence. Each inference is sent
once; the cancellation scenario's deliberate duplicate keeps the original ID.

### Independent checks

For each attempt the harness compares SDK/raw-client observations, read-only SQL
state, the provider process's in-memory event stream and its separately written
ledger. A safe `not_dispatched` result requires zero provider entries. A completed
result requires exactly one entry and a validated terminal SSE frame with the
expected fixture output and usage. Unexpected ambiguous effects or client stream
failures fail the run. Deliberately canceled requests retain `effect_unknown`.

Closure is checked independently of request effect. The original execution,
request, worker, closure token and native origin/incarnation/nonce/generation
are captured before body consumption or cancellation. Readback must preserve
that full tuple and prove context completion, forwarding return, known and
closed body, no close failure, native acknowledgement and released SQL
occupancy. The test does not manufacture ACKs or write SQL cleanup state.

All original preparations are journaled before transmission. If bearer issuance
is refused after a durable preparation, its original operation is read back and
its unique original policy subject is fenced using the consumer-control SDK.
The final phase closes or fences every original execution, waits for all cleanup
jobs to reach `done`, and requires zero open executions, zero occupied transports
and zero unresolved cleanup jobs before service retirement. Accepted effects are
checked again after cleanup.

### Bounds and evidence

| Bound | Value |
| --- | --- |
| Whole workload | 15 minutes |
| Each drain / cleanup wait | 60 seconds |
| Scenario timeout | At most three minutes and remaining whole-workload time |
| Inference attempts | 2,048 |
| Normal execution preparations | 96 |
| Explicit bearer-cap preparations | At most 130 attempts; at most 130 total durable executions |
| Accounts | 32 |
| Output per stream | 8 MiB |
| Total consumer/provider output bound | 512 MiB per side |
| Safe artifact total | 64 MiB |
| Resource sample interval | 250 ms |

The source manifest hashes the production service, SDK source, migrations, all
load tooling, manifests and lockfile before and after measurement. A separate
SDK artifact digest hashes the actual resolved built JavaScript. Both must stay
unchanged. The native executable and migration set have their own digests.

Exported artifacts are `operator-result.json`, `summary.json`,
`source-manifest.json`, `native-migrations.json`, `attempts.json`,
`scenarios.json`, `provider-ledger.ndjson`, `resources.json`, `cleanup.json`
and `preparations.json`. They contain safe identities, counters, classifications,
timings and hashes. Configuration files, bearer tokens, closure tokens, DSNs,
private keys and provider request/response bodies are not exported. GitHub Actions
retains its artifacts for 14 days, including safe diagnostics from failing runs.
When a child fails before the workload can write its own summary, the operator
records its bounded exit/signal facts and allowlisted fixture or runtime error
codes. Private child output is never copied into the exported receipt.

Resource samples cover the Node process running both the load driver and
`startService`, the exact live native engine PID/birth identity, SQL occupancy,
active queries, lock waiters and observer query latency. Node CPU and RSS include
the driver; they are not isolated service-only measurements. CI allocates two
CPUs and 4 GiB. This bounded synthetic qualification establishes behavior under
the specified workload, not production throughput, a long-duration soak result,
or external-provider latency and quota characteristics.

## Examples

Run the independent oracle behavior tests after the frozen dependency install:

```sh
pnpm --dir services/account-gateway run test:load:unit
```

Build the native fixture from a clean checkout at the exact pin, using qualified
Go and task-owned `GOCACHE`, `GOMODCACHE` and `GOPATH` directories:

```sh
node services/account-gateway/test/load/build-native-fixture.ts \
  --native-source /absolute/disposable/native-source \
  --output /absolute/disposable/native-build
```

Inside a disposable root container with `--network none`, the three TCP
`--sysctl` settings from the workflow, PostgreSQL 17.10, OpenSSL, the selected
Node runtime and read-only source/build mounts, bind-mount a freshly created
root-owned mode-0700 artifact directory as the only writable host mount. The
operator requires that directory to exist and be empty:

```sh
node /absolute/account-gateway/services/account-gateway/test/load/provision.ts \
  --repo /absolute/account-gateway \
  --build-receipt /absolute/disposable/native-build/build-receipt.json \
  --pg-bin /usr/lib/postgresql/17/bin \
  --artifacts /absolute/fresh-safe-artifacts \
  --gateway-commit FULL_GATEWAY_COMMIT_SHA \
  --trust-mode container --suite all --seed 20261023
```

The checked-in workflow contains the complete mount, toolchain and invocation
recipe. Select **Run workflow → suite: all** for the full matrix on both Node
versions. Pull requests run `suite: all` automatically; `suite: smoke` remains an
explicit manual option. Only `--trust-mode container` is supported. The container
marker check runs before provisioning, and the operator independently rejects
networking beyond loopback. Do not run the operator directly on an ordinary host;
repository code is loaded before its runtime misuse guards can execute.

For targeted diagnosis, the operator also accepts an individual scenario name
as `--suite`. With an already provisioned private manifest, `AG_LOAD_SCENARIOS`
selects one of the same eight names. Omitting that variable selects the full
matrix; an unknown name is rejected. Targeted runs do not replace the full
matrix's evidence, and edited source requires a fresh qualification.
