# @agent-teams/account-gateway

Private facade v1 SDK. Requires Node 24.21 and server-owned gateway origin and
role credential. This package does not qualify Sub2API or implement a backend.

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
