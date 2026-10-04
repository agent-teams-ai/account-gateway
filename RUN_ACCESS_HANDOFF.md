# Per-run backend access handoff

Source supplied: source5faa accepted as PR9 merge da8b8030.
Observed: frozen53 SHA256 66a2393e7a55f76df1a78281af44379d0b455a0770d82f34e587dcca284157b0.
Linked Git preflight cannot resolve its external worktree metadata; patch export is used.
This is a backend seam, not D-min/product E2E, daemon, UI or OAuth qualification.

`POST /internal/v1/run-access` is the single new private control operation.
Authenticate with `Authorization: Bearer <configured run-control token>`;
`Content-Type: application/json`, `Accept: application/json`, no query/encoding.
Execution and management credentials cannot invoke it; run-control cannot invoke
public management or execution routes. Registry issuance also checks the current
run-control role at runtime. Never give this credential to CI.
Configure `RunControlBearer` with a fixed `consumerId`, `ownerRefs`, `profileIds`,
five limit ceilings and `maxRunMs`. No body consumer/role/owner impersonation.

Body uses the unchanged strict v1 Prepare schema:
```json
{"operationId":"stable-operation","invocationRef":"opaque-run","attemptRef":"opaque-attempt","accountRefs":["00000000-0000-4000-8000-000000000001"],"subjectRef":"opaque-binding","policyRevision":2,"bindingRevision":3,"profileId":"qualified-profile","limits":{"requests":4,"concurrency":1,"requestBytes":4096,"outputBytes":4096,"tokens":100},"deadline":"2026-10-04T12:00:00.000Z"}
```
RR backend constructs every field from its persisted, verified admission;
accountRefs is the server-approved ordered subset, never CI account selection.
Gateway checks configured consumer/owner/profile/limit/maxRun scope and account
ownership, prepares through existing kernel/HMAC/issuer, then reads the original
SQL SavedExecution. Account metadata reads establish ownership only; they never
reconstruct admission, generation, epoch, deadline or limits.

Success is HTTP 200, no-store, with this private envelope:
```text
{operation: <v1 applied preparation operation with execution result>,
 bearer: <opaque execution-scoped credential>, admission: <v1 Admission>}
```
Only this backend response carries a credential. Admission and execution result
are existing public projections; generation and issuer remain server-private.
Errors are unchanged safe v1 DTOs (400 invalid, 401 authentication, 403 denied,
409 changed intent, 404 absence, 503 unavailable); no secret/vendor details.

Bounds: 16 permitted UUID accounts, 100 configured owners, 128 profiles,
maxRunMs 1..3600000; references <=128 characters, profile IDs <=64,
deadline ISO timestamp <=64; control credentials 16..1024 allowed ASCII chars.
All five limits are positive integers within configured/v1/kernel ceilings,
profile token cap and ingress byte cap; concurrency <= requests. 16KiB control body,
16KiB raw headers/32 fields and existing singleton auth/content headers.
The bearer registry has 128 total configured + dynamic entries; saturation
fails closed without evicting a neighbor or durable evidence.
Replay the identical body and stable operationId after a lost response. The
kernel compares persisted original intent; modified intent conflicts. Concurrent
same-run replies retain one execution and scoped bearer; independent runs coexist.
Closed/expired/fenced/reconnected/restored authority cannot mint usable access;
request/callback paths still recheck SQL epoch, fence, deadline and sole claim.
Restart drops in-memory access credentials. Authenticated identical replay may
recover original SQL authority only if still live; it cannot reset claims or pin
new account/epoch/invocation/attempt. Keep intent HMAC configuration stable.

RR owns verified OIDC repo/workflow/event/run/attempt/approved head, live workspace
membership/binding/config and persisted original tuple; it must preserve actual
fork/event authorization and revalidate before admission. Repository settings
changes govern future runs; explicit revocation requires the existing durable
policy-fence ACK, and run completion/abandonment requires existing close routes.
RR holds service and execution credentials and relays approved request/readback/
close routes; CI receives neither upstream/master/management nor gateway access.
Do not retry ambiguous inference or select another account/invocation/attempt.

Remaining composition: enroll the separate RR backend's run-control credential
and ceilings at the service boundary, call this route from RR admission, retain
its original body/admission, and connect the existing execution relay/close.
No SDK/schema/kernel/Go/dependency/migration changes. First real MiMo CI tools,
parsed final review and exact-approved-head App publication remain unqualified.

Nearest regressions: execution/foreign-consumer minting, parallel X/Y grant
revocation, original-intent recovery under drift and terminal SQL denial.
`node --check` passes for changed TS files; this is syntax only.
Typecheck NOT_RUN: `node node_modules/typescript/bin/tsc --project
services/account-gateway/tsconfig.json` cannot resolve the pinned compiler.
PG/HTTP NOT_RUN: `node --test --test-concurrency=1
services/account-gateway/test/run-access-postgres.test.ts` cannot resolve `pg`.
No workspace dependencies are mounted; the supplied existing qualification cache
path is absent, and pnpm's corepack executable is absent. No install or substitute
compiler was used. Run the suite with a NEW empty localhost PG17.10 database:
`AG_RUN_ACCESS_TEST_DSN`, `AG_RUN_ACCESS_DISPOSABLE_DB=ag_kernel_test_<suffix>`,
`AG_KERNEL_TEST_ALLOW=disposable_pg17_10`. Pinned checks and independent review
are still required before integration; no green runtime receipt is claimed.


## Primary qualification after worker completion, 2026-10-04

The preceding NOT_RUN statements describe the producer sandbox. Primary applied
its exact patch to the accepted 5faa7702 tree and ran the pinned TypeScript 7.0.2
compiler: PASS. First container attempt stopped at unresolved pg because the
existing pinned dependency cache symlink target was not mounted. No test passed
from that attempt. The corrected disposable PG17.10/HTTP run reached all tests:
BEFORE 1/7 passed, six failed when later fixtures reused native ID/CreatedAt.
The fixture now allocates unique physical IDs across its cases, as the existing
facade fixture does. AFTER 7/7 passed, zero skips; strict typecheck passed again.
Two literal synthetic API keys were replaced with runtime-generated values; the
unchanged installed worker-output scanner accepts the patch. Original rejected
preimage and failed receipts are retained outside source, without printing keys.

Final qualified production/test patch SHA256 before this prose/CI addition:
9867d963633815bc98271164266cd1499ed2647e712b80e2b18abacd5a947919.
PG/HTTP output SHA256:
73f3226887d420a7d689ebe9e3dfddd8f3f48830364c35908367550b4f1e4081.
The workflow now runs this nearest boundary in its own newly created database.
Both primary disposable containers were removed after receipt capture. Controlled
native fixture only: zero actual provider calls. Independent source review and
current CI remain required; this does not prove real agent/T0/parser/App E2E.
