# @agent-teams/account-gateway

Private facade v1 SDK. Uses Node 26.11.1 by default, with Node 24.21.0 compatibility,
and requires a server-owned gateway origin and role credential. This package
does not qualify Sub2API or implement a backend.

Import safe schemas/types from `/contracts`, server clients from `/http` and
optional static construction from `/get-modular`. Browser resolution of the
server entries is explicitly blocked. No root or private wildcard export exists.

Management owns profiles/accounts, preparation and policy fences; execution owns
request/status/close and scoped operation readback. The service must enforce the
same authenticated roles and consumer namespace. Client shapes are no substitute
for server authorization. Credentials enter management submission only; they do
not appear in safe contracts or readback results.

All POST/PATCH calls are single-attempt. Supply a stable operationId/requestId
before dispatch; `operationPath`/`requestPath` work before an acknowledgement.
An error with `effect_unknown` requires reconciliation of that identity. A
readback 404 cannot establish no effect. Do not replay using a fresh identity.
Native requests supply approved JSON protocol bytes unchanged, plus bounded
trusted admission in `x-gateway-admission` and stable `x-gateway-request-id`.
The facade responds with `x-gateway-request-ref`. These are our facade headers,
not existing engine headers. Streams remain bytes; the SDK does not parse SSE
or record output. A repeated request may return `{kind:'status', status}` at
202; a new stream returns `{kind:'stream', body, cancel, requestRef}`. Consume
or cancel every stream. AbortSignal, explicit cancellation, output limits and
zero-prefetch application streaming propagate cancellation to the transport.

Build-time caps are safety ceilings, not measured production capacity. The
server must enforce numeric policy and deadline before accepting effects.
Consumer domain/application code owns its own ports. Translate safe SDK DTOs
in the consumer's outer adapter. Never import framework or vendor DTOs into
consumer policy. Host factories privately supply config; profiles carry no
secrets or tenant authority. Host owns cleanup; Assembly adds no lifecycle kernel.

The server-only HTTP entry exposes secretSubmission.connect/reconnect/credential
schemas for facade ingress reuse. secretSubmission.nativeRequest validates the
unchanged byte body and admission envelope; /contracts exports listQuery and its
derived ListQuery type, so the facade need not duplicate query validation. Their types are submission inputs, never safe
readback DTOs. Keep validation failures redacted at the service boundary.

Repository development: pnpm install --frozen-lockfile, pnpm build, pnpm test,
pnpm foundation, pnpm check:topology and pnpm docs:check. Pack with pnpm --dir
packages/account-gateway pack; run scripts/qualify-consumers.sh with the absolute
archive and a new directory outside the source workspace. See docs/HANDOFF.md
for current gate results and root documentation adoption prerequisites.

## Account model discovery

Management and consumer-control clients expose `readAccountModels`; execution
clients do not. The read accepts the current owner, account, qualified profile
and expected authorization epoch, with optional `forceRefresh`. It does not
submit an inference request or transfer a provider credential.

`accountModelDiscoveryProfile(profileId)` identifies the qualified discovery
profiles and their source, protocol and auth kind. A lookup can trigger a strict
read; use `accountModelDiscoverySource({profileId, protocol, authKind})` against
trusted current profile metadata before treating a snapshot as model authority.
The qualified sources are Codex OAuth over Responses and OpenRouter API keys
over Responses. Vendor labels and arbitrary profile IDs cannot enable discovery.

An authoritative `snapshot` carries its source, physical generation, principal
version, fetch time, expiry and the complete model/capability set. Codex retains
its 128-model limit and existing balanced/function capability contract.
OpenRouter admits at most 2,048 models, has no fast-mode claim, and exposes only
normalized none/function tool capabilities. When the [public model metadata](https://openrouter.ai/api/v1/models)
supplies `reasoning.supported_efforts` and `reasoning.default_effort`, the paired
producer can qualify explicit compatible values and a member default. A parameter
name alone does not establish allowed effort values; missing or invalid metadata
leaves reasoning controls null. Empty snapshots remain authoritative empty sets.
Unknown, unsupported and unavailable results never invent dynamic membership.
The generic `accountModelCapability` schema and `AccountModelCapability` type
accept rows from either source; complete snapshots additionally enforce each
source's stricter capability and size contract. A null reasoning or fast field
means the Gateway has no qualified control to expose; it does not establish that
the provider itself lacks that capability. During a coordinated upgrade, enable
the compatible catalog and inspect existing OpenRouter selections against the
refreshed snapshot. Resave only explicit controls that are no longer qualified
with provider defaults before resuming those reviews; still-qualified effort
values remain valid. Unqualified explicit controls fail closed rather than being
silently ignored.

For complete catalogs, construct the model-reading client with
`responseBytes: 2 * 1024 * 1024`. The explicit ceiling is 2 MiB; the default stays
64 KiB and is never silently bypassed. Other SDK buffer defaults and ceilings
are unchanged. Native model reads use the same 2 MiB response ceiling.

The Gateway rechecks account identity and authorization around discovery,
verifies source/profile consistency, and rejects future-dated or expired
snapshots. Both facade request admission and the saved-lease native authority
reuse the same model-discovery port. A request selects a discovered model without
rewriting the enrollment descriptor or its immutable birth model. OpenRouter
configuration may capture any syntactically safe anchor under its fixed provider
origin; Native must verify live catalog membership before creation/activation.
A source outage retains only the existing immutable-anchor fallback, never the
last expired catalog as authority for other models. Unknown, unsupported and
empty catalogs authorize no fallback models. Malformed or missing observations,
failed native HTTP reads, and expired or future-dated snapshots are unknown;
only an explicitly observed unavailable result permits the anchor fallback.

Upgrade the SDK, Gateway service and qualified Native producer together before
enabling OpenRouter discovery in a consumer. An older producer returning
unsupported cannot become dynamic merely because a newer client understands the
source. Consumer rollout switches and display-only public pricing remain owned
by the consumer, independently of this admission contract.
