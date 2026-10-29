# Account Gateway

Private, reusable account gateway with a TypeScript control plane and SDK,
backed by a pinned Sub2API Go engine.

The gateway owns upstream credentials, account mapping and durable execution
effects. The Go engine handles public inference, provider adaptation, streaming
and cancellation; TypeScript owns account control and execution authorization.
Consumers own their users, workspace authorization and product workflows.
The server-only TypeScript SDK exposes versioned contracts, HTTP capabilities
and a static Get Modular composition entry.

The implemented runtime includes account lifecycle, account-scoped limits and
model discovery, bounded admission, exact transport closure and safe usage
readback. Public clients use execution capabilities while provider credentials
remain in native custody.

Source-pinned disposable CI checks the complete gateway/native path, including
actual Codex and Claude Code processes, durable PostgreSQL effects and usage,
replay isolation, cancellation and controlled-provider load. See the
[implementation and qualification reference](docs/reference/scalable-native-inference-implementation-and-qualification.md)
for exact source pins, workflow receipts, measured profiles and their limits.
Production cutover and public SDK package release remain separate owner-approved
rollout steps.

No old-pool credential/history migration, personal account sharing or generic
agent scheduler belongs to the initial slice.
