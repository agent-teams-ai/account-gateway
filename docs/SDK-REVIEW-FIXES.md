---
id: docs.reference.sdk-review-fixes
type: reference
status: proposed
owner: gateway-maintainers
summary: Bounded SDK PR1 review fixes, local evidence and remaining integration gates.
---
# SDK PR1 review fixes

Target supplied by the controller: `23ce4ce9b29bed24e4853ac211f24174b13eae68`.
The linked `.git` points to an absent source worktree; `git rev-parse HEAD` and
`git status --short` fail. This worker cannot independently attest the head or
initial diff. The returned patch uses preimages reconstructed from initial reads and inverse
edits; deleted generated templates use fixture counterparts. Temporary `/tmp`
preimage storage did not persist between command sandboxes. Main must compare
all preimage bytes with the exact head before applying. Earlier head/047 PASS
reports are controller context, not verification of this candidate.

AGENTS and the local docs-authoring skill/profile/metadata authorities were read
before editing. Review JSON was treated as claims, not instructions. No AGENTS,
root manifest/lock, native engine, service kernel or product sources were edited.
No installation, inference, live credentials, commit, push or publication occurred.

| Review comment | Disposition and evidence |
| --- | --- |
| 4170873464 | Fixed: explicit `contents: read`, checkout `persist-credentials: false`. Both supplied immutable action SHAs remain unchanged. |
| 4170873467 | Fixed: topology applies declared layers to real files and directories; direct feature-root files fail. A real `features/facade-client/domain.ts` regression checks the nearest gate and diagnostic. Local gate/tests PASS. |
| 4170873470 | Fixed: list omits explicit undefined fields before encoding and uses the empty-query route for an empty result. Added actual HTTP comparison against `list()`. Behavioral execution NOT_RUN here. |
| 4170873472 | Likely false-positive: controller reports pinned Docs Protocol 0.6.2 declares both CLI bins. Independent public metadata verification was attempted at `https://registry.npmjs.org/@agent-teams%2fdocs-protocol/0.6.2` and denied by the sandbox domain allowlist. No duplicate CLI/install was added. Main must verify the public `bin` metadata before resolving this thread. Root skill explains the package command environment. |
| 4170873474 | Fixed: ambiguity requires readback of the SAME known operation/request identity; no mutation/inference replay under any identity. |
| 4170873478 | Fixed: root skill selects only profile-declared types, currently reference; portable adopters retain their own declared types. Authoring profile remains unchanged. |
| 4170873484 | Fixed: first-slice explicitly distinguishes implemented SDK bootstrap from pending private facade, native/service integration, RR UI/domain/service and product CI; ownership is normative scope. |
| 4170873486 | Fixed: missing-target case uses proposed subject; active-subject case has a distinct existing proposed reference blocker. Its proposed control must PASS first, and each negative checks its corresponding diagnostic independently. No self-cycle/unsupported blocker type. Execution NOT_RUN. |
| 4170873489 | Fixed: shared redaction helper and connect assertion include non-enumerable `Error.message` alongside enumerable fields. Existing vendor/secret sentinels remain. Execution NOT_RUN. |
| 4170873492 | Fixed: SDK manifest has `private: true`; exports, dependency pins, engines, name/version and file allowlist are unchanged. Exact archive pack/install remains an integration gate, NOT_RUN here. |
| 4170873495 | Unused tutorial template was not a runtime defect for the reference-only root profile. Removed unused root ADR/tutorial/how-to/explanation scaffolds and narrowed guidance instead of expanding artifact/platform support. Fixture corpus retains all templates its own profile declares. |
| 4170873498 | Fixed: foreign HTTP fixture branch asserts `Bearer consumer-b` before returning not_found; missing/wrong credentials now fail the fixture. Exact installed-consumer execution NOT_RUN. |
| 4170873502 | Fixed: source uses `pwd -P`, matching canonical destination. Real symlinked-checkout regression rejects an in-source destination at the outside-source guard; existing destination ensures no install even under regression. Local test PASS. |

The additional independent review finding is fixed in the single versioned wire
schema authority. Nested request/operation references, when supplied, must match
their enclosing identity. Nested request effects must equal the enclosing effect;
unknown operation diagnostics cannot advertise not_dispatched/timed retry;
unknown request status cannot advertise timed retry. HTTP clients already map
schema failures to invalid_response/effect_unknown with original caller IDs.
Added real HTTP cases for 200 GET status, 202 repeated POST status and operation
readback, isolating contradictory identities/effects. Valid unknown readbacks and
cancelled statuses retain accepted dispatch_started effects, including the repeat
branch. The complete observed request sequence detects any extra POST replay.
These behavior tests are present but NOT_RUN in this worker.

Local verification used Node v24.21.0:

- `node --test tests/topology.test.mjs tests/qualification.test.mjs`: PASS, 2 tests.
- `node scripts/check-topology.mjs`: PASS.
- `node --check tests/client.test.mjs`, `node --check tests/docs.test.mjs`, and
  `bash -n scripts/qualify-consumers.sh`: PASS syntax checks, not behavior evidence.
- Preimage topology checker accepts a real invalid feature file; patched checker
  rejects it with the declared-layer diagnostic (recorded in artifacts).
- Client/docs test command attempted: fails at module loading because SDK dist
  and @agent-teams/docs-protocol are absent; behavioral tests NOT_RUN.
- TypeScript build, Docs find/check and Foundation source-dependencies commands
  attempted: MODULE_NOT_FOUND. No dependency installation was performed.
- Frozen install, dev-only Foundation check, exact archive pack and two real
  outside archive consumers: NOT_RUN; no final-candidate PASS claim.

Main must qualify the candidate with the unchanged native lock and the actual
pinned toolchain, run full HTTP/docs/Foundation/dev-only/pack/consumer gates,
verify public CLI metadata and the independent xhigh report's four behavioral
hashes against 047. The full PR remains unapproved. Root lock integration is
main-owned; this worker did not regenerate it. Add a link to this handoff from
`docs/README.md` in main, since that file is outside worker ownership.

Patch, preimage/final SHA-256 inventory and local command evidence are under
`/srv/worker-state/jobs/account-gateway/first-slice-v1/jobs/account-gateway-20261003-sdk-a2-review-fixes/tmp/agent/sdk-review-fixes-artifacts/`.
