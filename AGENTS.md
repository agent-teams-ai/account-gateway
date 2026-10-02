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
- Add tests for observable behavior or an independent security/lifecycle
  contract with a plausible regression; no source-string or mock-only assertions.
- No independent SDK paid retry, hidden failover or replay after an ambiguous
  dispatch. Accepted effects survive revoke/expiry/cleanup classification.
- Verify current stable dependency releases and supported toolchain before
  installing; pin qualified versions and retain one native lockfile.
- Stage release changes as bounded dependency-safe PRs. Product production
  cutover and public package release require their applicable owner approval.
