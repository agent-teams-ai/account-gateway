# Controlled native MiMo assembly remediation

Bounded repair of preserved rejectedterminalpartial 970cc1a8; source/test handoff only.
Changed: `services/account-gateway/test/native-runtime-assembly.test.ts`,
`services/account-gateway/test/fixtures/native-assembly/main.go`, this handoff.
Fourth owned file `architecture/foundation/source-dependencies.yaml` remains identical;
its existing assembly test boundary already permits the actual imports.
No production Go/Node/SDK/SQL, dependency, lockfile or CI edits.

Supplied attested base: c5a93858d8bc0141f4310a389034740142b6c52e.
Primary target Node: fdcd7244fea9e29919318fb60b2150477956abd9 (P1/P2 delta supplied).
Native: a5aae50d4c9e628a116fe3742e9b66d0c328ce4a (frozen bootstrap/launcher bytes).
All 13 input hashes match INPUT-MANIFEST.json, including full53 SHA-256
`66a2393e7a55f76df1a78281af44379d0b455a0770d82f34e587dcca284157b0`.
Read full53, prior-scope-error identity, actual a5 APIs and fdcd delta; delta not applied.
One Git preflight failed on inaccessible linked-worktree metadata; no Git writes.
Supplied identities are not observed HEAD/ancestry. Original PID absence is supplied.

Before verification: old fixture requested the legacy bridge and served Chat chunks.
Actual a5 `ProfileConfig.qualified()` and `privateHandler()` fix GatewayMiMoResponsesProfile;
management.create cannot promote that old request. This source-established failure
was recorded before checks; an executed red assembly receipt is NOT available here.
Norm53 line28 instead requires native MiMo API-key Responses.

Repair: `openai-responses-apikey-v1`, controlled TLS POST `/v1/responses`, native
Responses event sequence ending in actual `response.completed` content and full usage.
Assert forwarded text delta, terminal model/content, input/output/total/reasoning usage.
Model/baseURL remain owned by the actual qualified server configuration.
The existing five-second parent command wait now receives two-second pulses after ready;
pulses end on stop/exit, never alter claim/closure authority, and never restart the child.
Actual uint64 launcher facts and retirement binding use decimal safeBinding projections.
Receipt scope/method and complete original binding are checked, after actual ReadReceipt.
Go normal TLS verification uses explicit fixture SSL_CERT_FILE and fixture SSL_CERT_DIR;
fixture directory contains only the supplied fixture PEM files, with no ambient roots.

Preserved: fresh designated PG + full actual repository.ApplyMigrations; protected
launcher FD6 from root-private0600 config, UID/GID65534 and empty supplementary groups;
foreground gatewaybootstrap.Run(ctx, Options{}); original actual launcher enrollment;
encrypted management.create/readback/proof/promotion and credential erasure; actual
NativeAuthority/NativeHTTPTransport/facade/kernel SQL; two sequential real provider entries,
two distinct durable SQL claims on SAME OPEN execution at concurrency1; positive actual
native physical closure + authenticated ACK + released SQL occupancy before request2;
wrong-role native POST403 with zero additional provider entry/claim/ACK; actual retirement.
No converter/fallback, manual mapping, unconditional proof, unsafe TLS or injected upstream.

Worker verification: pinned Node24.21.0 syntax check PASS; all unowned source hashes
unchanged. Strict TS typecheck, Foundation, Docs CLI and Go build/vet: NOT_RUN (no
installed workspace dependencies/compiler/Go; pnpm corepack target absent).
Actual assembly: NOT_RUN. No Docker, sockets, provider keys/paid calls, runtime/auth
access, other jobs, git add/commit/push or assembly execution by this worker.

Primary retains the existing disposable root runner in its own PG network namespace,
Go1.27.1/Node24.21.0/PG17.10 and locked dependencies. Apply these four owned files to
actual fdcd; copy helper into actual a5 backend/cmd/gateway-assembly-fixture/main.go.
From that backend, with the supplied pinned compiler/cache:
```sh
GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off go build -o /opt/account-gateway-assembly/gateway-assembly-fixture ./cmd/gateway-assembly-fixture
GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off go vet ./cmd/gateway-assembly-fixture
```
Install ELF root0755 single-link/no capabilities under protected ancestors; install only
fixture tls/ca.pem and server.pem root0444, server-key.pem root0600, SAN127.0.0.1.
From gateway root, with two NEW empty designated fixture databases:
```sh
pnpm run build
pnpm exec tsc --project services/account-gateway/tsconfig.json
pnpm run foundation
AG_ASSEMBLY_ALLOW=disposable_root_pg17_10 \
AG_ASSEMBLY_KERNEL_DSN='postgres://postgres@127.0.0.1:5432/ag_kernel_test_assembly_UNIQUE?sslmode=disable' \
AG_ASSEMBLY_NATIVE_DSN='postgres://postgres@127.0.0.1:5432/native_bootstrap_assembly_UNIQUE?sslmode=disable' \
node --test --test-concurrency=1 services/account-gateway/test/native-runtime-assembly.test.ts
```
UNIQUE is a new 1..32 lowercase/digit/underscore suffix. Require 1 PASS,0 FAIL,0 SKIP;
retain exact source/image hashes and TAP. Missing prerequisites fail, never skip.
Failed authority survives until runner disposal; only proven retirement removes its directory.
Real Codex/MiMo tools/final/parser/same-head App qualification remains separate UNPROVED.


## Primary qualification, 2026-10-04

Actual gateway source fdcd7244 / accepted b794 tree; native source a5aae50d / accepted045 and0a88 runtime bytes. Node24.21.0, TypeScript7.0.2, Go1.27.1, PostgreSQL17.10 digest7958605b. Direct existing SDK build, strict kernel+test typecheck, Foundation1.7.1 boundary check, pinned offline actual helper go build/vet PASS. Original worker marked these NOT_RUN; this later primary receipt does not rewrite its claims.

Initial compiler run failed on the missing-DSN branch; explicit return-never fixes narrowing without changing runtime semantics. First actual assembled test failed because fixture SQL referenced a nonexistent probe_enabled column. Existing Extra probe/rate-sync flags are now checked instead; production SQL/Go/Node unchanged.

Actual controlled assembly v2: 1 PASS, 0 FAIL, 0 skipped. Fresh designated kernel/native DB pair; complete actual native migration runner; inherited-lock launcher and dropped-UID engine; real encrypted create/readback/promotion/intent erasure; two distinct durable claims and native closure ACKs in SAME OPEN concurrency1 execution; wrong-role403 with no third claim/provider entry; native ciphertext/inert scheduling; exact launcher retirement/readback.

Receipts: qualification-native-assembly-v1/results/direct-* and actual-assembly-v2-{launch,result}.json/log on workers-fsn1-01. Binary and final harness hashes are in launch/result. Isolated Docker PG network namespace, no host networking, controlled fixture upstream only. No real provider key/paid traffic, CLI/tools/final/parser/App or RR T0 qualification. Canonical source review/CI of this harness candidate still required.
