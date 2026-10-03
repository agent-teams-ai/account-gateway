# B3a private native management checkpoint

Owner: gateway-maintainers. Date: 2026-10-03. Status: implementation checkpoint;
**focused checks qualified by primary; source review/CI and assembly pending**. Only the seven requested paths are added. No
kernel, SDK, dependency, lock, facade, launcher, OAuth or production file is edited.

Supplied source: `ded1530216501416605293398a970bbf3e19d092`. Observed HEAD:
**UNVERIFIED**. The linked `.git` points at unavailable
`source-kernel-merged-ded15302/.git/worktrees/native-management-adapter-b3a`;
`git status --short` failed. Integration must verify exact HEAD and preimages.
Normative contract53 bytes were read and verified as SHA-256
`66a2393e7a55f76df1a78281af44379d0b455a0770d82f34e587dcca284157b0`.
Supplied Q and the documentation authoring skill were read. This owner-requested
handoff lives outside the Docs Protocol catalog; no catalog/authority edit is added.
The installed Docs Protocol qualification is NOT_RUN.

## Boundary and behavior

`AccountManagement` composes the existing DurableKernel with custody, private
storage, candidate HTTP and controlled proof ports. It never invokes prepare,
claim, effect or transport-closure acknowledgement. Begin/start/ack/unknown,
account metadata, epoch/fence/operation and cleanup decisions remain kernel-owned.
Every accepted consumer, operation, key, owner/profile/name and revision primitive
is captured before the first await. Safe results use existing kernel DTOs; SDK v1
mapping belongs to the downstream facade, with its existing schema authority.

`IntentSecrets` uses distinct externally supplied 32-byte server keys for HMAC
and AES-256-GCM. HMAC binds a fixed versioned tuple including every accepted
intent primitive and the exact submitted key. Private transient AAD binds consumer,
operation, account, owner and create/reconnect purpose. Keys are neither discovered
from environment nor persisted. Decrypted byte buffers are cleared; immutable JS
strings and HTTP buffers are not claimed to be zeroized. Safe DTOs expose neither
HMAC nor credentials/descriptors.

004 stores only bounded binary envelopes in `ag_management.transient_intents`;
there is no credential JSONB column. TTL defaults to 60 seconds, caps at 5 minutes,
and never renews. Per-consumer transient rows default to 256, cap at 4096, and
saturate rather than evict unresolved replay evidence. Maintenance defaults to
100, caps at 1000. Ciphertext/nonce/tag are erased after an attempted create,
before readback, on recovery or bounded expiry reconciliation. Settled kernel
operations allow bounded deletion of erased transient rows. An expired staged
operation retains a nonrenewable erased tombstone; the existing kernel has no
staged-intent cancellation primitive. A future owner-approved lifecycle port is
needed to settle that pending operation; this component does not invent one.

The one kernel create permit is consumed only after encrypted staging. Its exact
generation and original worker are journaled before native POST. Journal/mapping
updates are prohibited by SQL triggers. Physical UUID must equal the proposed
birth generation; native ID must be a positive exact JS safe integer; CreatedAt
is checked as RFC3339 text and retained verbatim, including nanoseconds and offset.
Mapping uniquely binds physical UUID and native ID/CreatedAt to the immutable
journal's exact owner/account/profile/baseURL/model. Promotion happens only after
one-generation GET, exactly one descriptor, controlled qualified inert proof and
mapping persistence. Qualified inactive staging is mapped before exact-descriptor
PUT activation; a second exact-generation GET must prove the same descriptor is
active before kernel promotion. Lost state ACK uses GET, without HTTP retry or
another create. Unexplained active rows with no persisted staging mapping quarantine.
A failed create ACK only permits that GET. No second create POST,
ID/name/latest-row repair, token comparison or refresh counter is used.

An existing journal never recreates. An interrupted creating operation may use
same-owner exact readback while its kernel lease is valid. Explicit protected
`recover` reconciles the kernel, erases remaining transient material, stores exact
readback and supplies the current worker's proof. A quarantined/lost-owner kernel
candidate cannot promote; its exact descriptor can enable cleanup. Unknown facts
are not proof of NoEffect. Reconnect, disable and rename delegate their epoch,
fence and metadata semantics to the kernel.

Cleanup compares the complete mapped descriptor after exact-generation GET and
revalidates the original kernel cleanup consumer/worker/token/scope/current lease
before native disable and erase. Exact-descriptor PUT disables the row, an exact
GET proves inactive state, and the current kernel lease is rechecked before POST
erase. The Go tombstoned/credentials_erased ACK is validated. Missing/mismatched/
ambiguous mapping quarantines. Erasure
and generation settlement cannot release transport occupancy. The trusted facade
can dispatch its existing generation `CleanupClaim` to `cleanupClaim`; execution
cleanup remains for B3. The convenience poller releases an execution job back to
pending and reports `transport_pending`; the integrated dispatcher should route
such jobs directly to its transport owner to avoid repeatedly selecting that job.
A lease loss during HTTP erase may prevent settlement; the effect stays uncertain
and no occupancy is released. A later missing readback is not guessed successful
erasure; native idempotent exact erasure/receipt qualification remains necessary.

## Existing private native wire implemented from supplied source

Primary supplied `.spike-inputs/native-wire-16d621c2/` during continuation, declared
native source `16d621c22385a83e4d068da70ebc280846dd8fb0`, tree
`3d356c11c365260116a121bb538d09f96851ba16`. All four source hashes in SOURCE.json
were verified. This is a verified source export, not observed native Git HEAD or
installed native custody qualification. Receipts retain those exact source bytes.

The client now implements the existing fixed `/private/native/v1/candidates`
POST, generation GET/PUT and generation `/erase` POST. There is no injectable wire
parser, route variant or erase encoder. Native singleton readback uses exactly
`descriptor`, `name`, `state`, `group_free`, `schedulable`, `probes_enabled`.
Descriptor fields are the actual GatewayNativeRoute JSON members: `account_id`,
`generation`, `created_at`, `profile`, `base_url`, `model`. Generation is the native
physical birth UUID required by the agreed custody lane. The client preserves
numeric account_id and CreatedAt string verbatim; no alternate public DTO exists.
Arrays, malformed/duplicate decoded members (including escaped aliases), unsafe
scheduling/probe/group flags, wrong generation and inconsistent state ACKs reject.

The create body uses only the agreed `generation`, `profile`, `name`, `api_key`,
`owner_ref`, `account_ref`. Consumer is absent from body and bound to the server
control client. The supplied baseline Go create struct still declares only the
original four fields and rejects unknown fields: the native custody lane MUST add
the agreed owner/account fields and derive consumer from authenticated private
composition/context, protecting immutable scope and AEAD. TS sends no four-field
fallback. Thus assembled current baseline/native custody interoperability is not
claimed; its pending agreed extension is an explicit integration dependency.

Controlled inert credential/profile proof remains a trusted composition port with
a server receipt; local disposable proof is not live provider qualification. First
paid canary is a separate explicit gate. Native encrypted custody/bootstrap,
callback/facade composition, B2a public effect ports, issuer restore acceptance,
key rotation/readback/erase/dump receipts, supervisor retirement and production
cutover remain downstream. This patch claims none of those gates.

The client uses a fixed configured HTTPS origin or numeric HTTP loopback origin,
one server control credential, Node HTTP(S) `agent:false`, no redirect/retry,
candidate-only routes and no provider/execution API. Defaults are 5-second whole
request deadline, 16-KiB header cap, 64 header count, 16-KiB request body and 64-KiB
response cap; configuration is bounded. Errors carry only classified codes and
`uncertain`. HTTP401 has no NoEffect meaning. Control does not receive or forward
consumer bearer tokens. An execution credential has no use in this management-only
client and must remain in a separate downstream execution composition.

Primary must also supply a qualified controlled inert credential/profile proof;
the fixture-only proof in tests is not paid/provider qualification. First paid
canary is a separate explicit gate. Actual native custody, authenticated bootstrap,
callback/facade composition, B2a public effect ports, issuer restore acceptance,
key rotation/readback/erase/dump receipts, supervisor transport retirement and
production cutover remain downstream. This patch claims none of those gates.

## Actual worker verification and remaining gates

Node is installed at 24.21.0. `node --test
services/account-gateway/test/management.test.ts` passed 10/10, zero skips: real
AES-GCM/HMAC scope and tamper, local HTTP lost ACK with one POST and exact GET,
redirect/401 sanitation, body/deadline/JSON bounds, server consumer binding and
physical precision checks, exact existing Go descriptor/cleanup wire, duplicate
JSON members/inert flags and actual header bounds. These are actual local HTTP and crypto checks.

Node syntax checks cover all five handwritten TS files. Syntax checking is not
TypeScript qualification. The 16 actual migrated PostgreSQL test cases are
written but **NOT_RUN**: no installed `pg`, TypeScript, psql, pg_dump or designated
new disposable PG17.10 fixture. The attempted PG command stopped at missing `pg`
before any test or database action. PostgreSQL tests require a NEW empty designated
localhost database and refuse existing schemas; they never drop or reset one.
They cover lost ACK/restart, encrypted body and actual dump, stable/changed intent,
TTL/erase/saturation, duplicate/immutable mapping, consumer isolation, real lock
mutation, bad readback/status/redirect, stale descriptor, epoch/metadata lifecycle,
expired owner/cleanup lease, held transport occupancy, lost activation ACK, unexplained active row and owned
intent expiry reconciliation.

`pnpm --version` failed because the installed wrapper references missing corepack.
No install or substituted/unpinned dependency was attempted. Meaningful typecheck,
actual migrations/PG/dump, pinned frozen qualification, existing domain/root/build,
Docs Protocol, assembled native integration, exact-head CI and independent
`gpt-6.1-sol/xhigh/default` review are **NOT_RUN**. Full Internet availability was
not qualified; local loopback worked. Filesystem/credential isolation was retained.
No hosted worker was launched, so runtime model/effort/tier was not independently
verified here. Primary owns the requested gpt-6.1-sol/high/default, NO FAST runtime
qualification. No credentials, provider call, real user project, commit, push,
deployment or production action was used.

Primary commands after supplying pinned dependencies and a separate NEW guarded
fixture (DSN is supplied privately; never export it):

```sh
pnpm --filter @agent-teams/account-gateway-kernel typecheck
node --test services/account-gateway/test/management.test.ts
node --test --test-concurrency=1 services/account-gateway/test/management-postgres.test.ts
```

The fixture uses `AG_KERNEL_TEST_ALLOW=disposable_pg17_10`,
`AG_KERNEL_DISPOSABLE_DB=ag_kernel_test_<opaque_suffix>` and matching local
`AG_KERNEL_TEST_DSN`. Use a different empty DB from the kernel suite.
No dependency or manifest change is included. Apply 001/002, the separately owned
003 when integrated, then 004 in the primary's qualified assembled migration run.

## Exact guarded artifacts

Artifacts are outside the source worktree at
`/srv/worker-state/jobs/account-gateway/first-slice-v1/jobs/account-gateway-20261003-native-management-adapter-b3a/tmp/agent/b3a-artifacts/`:
`b3a.patch`, `guard.json`, `preimages.json`, `apply-guarded.py`, `verification.json`
and bounded check output. The guard refuses a different HEAD, altered protected
preimages, existing owned files, wrong normative contract hash or modified patch;
it applies only the seven additions, without staging/commit/push. Hashes and exact
commands/results live in `verification.json`, avoiding a self-referential patch
hash in this handoff. Integration should review the patch before using the guard.
Keep this goal active until native custody/proof composition and required current
verification establish the full checkpoint.

## Primary qualification and dependency composition 2026-10-03

Original terminal candidate sealed on ded15302 with exactscope/preimages/hashes. Primary isolated clone composes B2a owner1db4530e2baa4aea7d7a1d622a82b304ae5bac34 (PR5 dependency, source review pending). Old001/002 SQL unchanged.
Frozen pnpm11.28.2/Node24.21.0, meaningful pinnedTypeScript7 typecheck, SDKbuild, HTTP/crypto10/10, real digest-pinned NEW PG17.10 fixture16/16 including actual pg_dump PASSzeroSkip. Initial dump failure was test connection using PGDATABASE URL alone; --dbname exactsyntheticDSN succeeded. Separate NEWdatabase reran all16 after B2a composition with exact6th native reservation, preserving generation erase transport occupancy/count/effect assertions.
Application/Postgres/HTTP and actual transport/dump test boundaries explicitly classified in Foundation; pure kernel authority has no added network/database dependency. Composed SDK rebuilt after dependency fast-forward, fullroot27tests and Foundation PASS; prior Docs Protocol/topology PASS. An initial stale dist root27run failed only newB2a wire case; retained as invalid build artifact, not a source defect.
Actual installed secret detector initially rejected only synthetic fixture literals; scanner-safe fixture data/auth expression keeps meaningful behavior. No detector/runtime override. TS scanner operator meaningful stricttypecheck PASS.
Primary receipts live /srv/workers/jobs/account-gateway/first-slice-v1/tmp/qualification-management-v1/results. Native encrypted custody/scope, exact inactiveactivation/erase lostACK receipts, protected bootstrap/registry/callback and realprovider/CI E2E remain distinct gates. Exact-source xhigh/default review and CI pending, no assembledB/D acceptance/deploy.
