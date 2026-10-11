---
id: docs.reference.handoff
type: reference
status: proposed
owner: gateway-maintainers
summary: Checkpoint A producer commands, results and remaining qualification gates.
---
# Checkpoint A handoff

The SDK covers all thirteen facade routes, safe strict schemas, distinct
management/execution clients, stable reconciliation IDs, bounded native byte
streaming and static public Core/Assembly construction. Credentials are confined
to the server-only HTTP secretSubmission seam; safe contracts contain none.
One facade-client feature owns behavior. Bootstrap README and AGENTS are retained.

Canonical commands (default Node 26.11.1; compatibility Node 24.21.0; pnpm 11.28.2).
Run in a job-owned external scratch copy with engine-strict enabled and scratch
caches/TMPDIR. Results recorded below retain their original runtime and scope.

```sh
pnpm --config.engine-strict=true install --frozen-lockfile
pnpm build
pnpm test
pnpm foundation
pnpm check:topology
node node_modules/@agent-teams/engineering-foundation/dist/cli.js assert-dev-only --consumer . --json
pnpm docs:check
pnpm --dir packages/account-gateway pack --pack-destination "$GATEWAY_SCRATCH/gateway-archive"
scripts/qualify-consumers.sh "$GATEWAY_SCRATCH/gateway-archive/agent-teams-account-gateway-0.1.0.tgz" "$GATEWAY_SCRATCH/gateway-consumers"
```

Producer attempt 2 results:

| Command / gate | Status | Evidence / limitation |
| --- | --- | --- |
| node scripts/build.mjs | PASS | Pinned TypeScript 7.0.2, strict declaration closure |
| node --test --test-name-pattern='public Core/Assembly\|server-only shared secret' tests/client.test.mjs | PASS | Two independent static/ingress tests |
| node --test tests/source-policy.test.mjs tests/topology.test.mjs | PASS | Three tests, including actual type-only and deep-import violations |
| node --test tests/docs.test.mjs | PASS | Five tests; repository-copy cases explicitly provision owner routing and exclude unsupported root README only in fixture |
| Foundation source-dependencies and assert-dev-only | PASS | Installed 1.7.1, zero violations/issues |
| Immutable Feature Module Standard digest | PASS | Matches 851653f96643cf0466b67ab22963661976b00de44840fa3144a48a8c054f95fa |
| pnpm 11.28.2 pack | PASS | Exact archive under .cache/artifacts; hashes exported with payload |
| pnpm docs:check | FAIL | Actual root catalog and adoption failures below |
| node --test tests/client.test.mjs (HTTP cases) | NOT_RUN | Sandbox blocked 127.0.0.1; no retry/bypass |
| Frozen clean native install; two outside archive consumers | NOT_RUN | Controller must run exact final candidate |
| Exclusive Git lock create/release | NOT_RUN | Linked Git administration path absent; attempted once |

Controller adjustment after producer handoff: AGENTS routing is now installed.
The supported Docs Protocol profile governs actual docs/ and package READMEs.
The repository-root README remains an explicit bootstrap exclusion because
0.6.2 cannot express a root-file collection; COMPOSITION records that limit.
Repository-copy tests now use the unchanged production profile and instructions.
Producer results above are historical; controller exact-candidate gates follow.

Final source payload and package hashes are exported under .cache/artifacts.
Because Git administration is absent, the new-file patch covers added files;
.gitignore is supplied as an exact full-file replacement in the source tar.
The controller must derive its tracked-file diff against the authoritative base.
This is a reviewable progress handoff, not checkpoint A acceptance.
The controller's earlier clean-install/archive PASS applies to its corrected
disposable candidate, not the final files here. Final clean install and two
outside-source archive consumers require controller requalification. The local
sandbox blocks private loopback HTTP; its real HTTP fixture gate is NOT_RUN here.
No native Sub2API, tenant persistence, service/UI/real CI or production readiness
is established. Actual CI dispatch, publication, commits and push were not run.

The repaired native lock was copied from retained input (registry qualification
by controller); no offline metadata lock synthesis or dependency repacking is
delivered. Canonical commands never depend on worker inputs. Root documentation
uses portable v4/authoring v3 and strict sidecar metadata to preserve bootstrap
prose; tests cover stale preimages, relations and supported preview/apply.

Source Git administration is inaccessible in this linked-worktree sandbox.
Patch export must preserve bootstrap and native worker changes. Controller owns
author/committer checks and independent gpt-6.1-sol/xhigh review before integration.

Continuation verification: list query and native request validators now have
shared authority surfaces; NativeRequest is derived from its validator.
Transport preserves cancelled versus invalid_response classifications while
keeping unknown effects and stable identities. The real HTTP suite additionally
checks cancellation during a partial mutation JSON acknowledgement; like the
other loopback fixtures, it requires controller execution here.

The two exact-archive consumers now materialize an owned ConnectionReader port
and scalar-only ownership function separately from the SDK adapter. Their pinned
TypeScript compile emits the fixture; shared-facade isolation invokes each
consumer's compiled adapter/port, including an independent owner-mismatch denial.
This gate remains NOT_RUN locally and must run on the final archive externally.

The reusable native request schema enforces the admission request byte cap;
client and future facade validation share that bound instead of duplicating it.
Continuation build, static/ingress tests, source policy and pack all PASS.
