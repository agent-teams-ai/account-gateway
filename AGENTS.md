# Agent Instructions

- Keep consumer policy independent of framework/vendor DTOs. Compose concrete
  adapters at the outer boundary. Reuse one versioned wire schema authority.
- Credentials are write-only. Never log/export keys, OAuth material, native
  admin responses or provider prompt/output bodies in diagnostics.
- Use only sandbox/test projects for agent runtime/launch/provisioning checks.
  Never use real user projects as smoke fixtures.
- Hosted workers use explicit gpt-6.1-sol and serviceTier default. PR review uses
  xhigh effort. Return patches/evidence; the orchestrator commits after checking
  author and committer are iliya <iliyazelenkog@gmail.com>.
- Preserve others' changes. Use conventional branch prefixes and commits.
- Use Node 26.11.1 as the active default and retain the required Node 24.21.0
  compatibility lanes. Existing engine ranges accept both; dependency versions
  and historical qualification receipts remain unchanged.
- Node 26 does not bundle Corepack. For hosted qualification, invoke the existing
  `/opt/nodejs/node-v24.21.0-linux-x64/lib/node_modules/corepack/dist/corepack.js`
  with the selected Node executable and the pinned pnpm 11.28.2. Use a job-owned
  nested pnpm shim, external scratch for dependencies/builds/caches/TMPDIR, and
  frozen installs with engine-strict; never install globally or waive engines.
- Add tests for observable behavior or an independent security/lifecycle
  contract with a plausible regression; no source-string or mock-only assertions.
- No independent SDK paid retry, hidden failover or replay after an ambiguous
  dispatch. Accepted effects survive revoke/expiry/cleanup classification.
- Verify current stable dependency releases and supported toolchain before
  installing; pin qualified versions and retain one native lockfile.
- Stage release changes as bounded dependency-safe PRs. Product production
  cutover and public package release require their applicable owner approval.
- Sub2API is the single source of truth for account state, quota, rate-limit
  and cooldown. Do not rebuild account scheduling, rotation, cooldown or
  failover in the gateway service, the SDK or any consumer. If the native layer
  lacks a behavior, extend Sub2API (for example mark an account paused
  with its native `rate_limit_reset_at` on a provider 429 and skip paused
  accounts at admission) and expose the result through the existing contract as
  a typed busy outcome with a retry-after. Consumers only list candidate
  accounts; they never keep their own copy of account health.
- Provider logic is owned by Sub2API, not by this repository or its
  consumers. Since 2026-11-21 the Sub2API source lives in
  `agent-teams-ai/sub2api-standalone` (not a GitHub fork, same `main`
  history); the old `agent-teams-ai/sub2api` fork is retired and gets
  archived, so do not open PRs there. Provider HTTP, parsers, codecs, model
  catalogs and provider-specific request admission live in native. The
  Gateway keeps contracts, identity, fences and policy, and its own admission
  checks stay. Reuse an existing Sub2API capability before writing anything;
  if it is missing, extend Sub2API. A model joins a catalog only with evidence it
  belongs to the plan, except where the owner chose the provider's own list
  (the coding plans and NVIDIA Build), and the catalog has exactly one source
  in native. Design: `ai-docs/architecture/64-gateway-native-ownership-and-model-catalog.md`,
  `65-live-coding-plan-model-catalog.md` and `68-nvidia-live-model-catalog.md`
  in the ReviewRouter repository (777genius/review-router-ai).

Use [docs/.agents/skills/docs-authoring/SKILL.md](docs/.agents/skills/docs-authoring/SKILL.md) for documentation.
