# @agent-teams/account-gateway

Private facade v1 SDK. Uses Node 26.11.1 by default, with Node 24.21.0 compatibility,
and requires a server-owned gateway origin and role credential. This package
does not qualify Sub2API or implement a backend.

Import safe schemas/types from `/contracts`, server clients from `/http`,
optional static construction from `/get-modular` and the experimental model call
from `/llm`. Browser resolution of the server entries is explicitly blocked. No
root or private wildcard export exists.

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
not existing engine headers. Streams remain bytes; the `/http` clients do not
parse SSE or record output. A repeated request may return `{kind:'status', status}` at
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

## Experimental llm entry

`/llm` is an experimental 0.x server entry for one bounded model call. Its
contract may change in any minor release. It composes the consumer-control and
execution clients and adds no retry, failover, replay, storage or logging.

```ts
import { createConsumerControlClient } from "@agent-teams/account-gateway/http";
import { createLlmClient, executionConnector } from "@agent-teams/account-gateway/llm";

const llm = createLlmClient({
  control: createConsumerControlClient({ role: "consumer-control", origin, token }),
  connectExecution: executionConnector({ origin }),
});
const result = await llm.generate({
  taskId: "summary-2026-10-30",
  attempt: 1,
  profileId: "openai-codex-oauth-responses-v1",
  model: "gpt-5.6-sol",
  accountRefs: [accountRef],
  policy: { subjectRef, policyRevision, bindingRevision },
  instructions: "Summarize the posts.",
  input: posts,
  output: { mode: "json_schema", schema },
  maxOutputTokens: 4096,
  deadline: new Date(Date.now() + 10 * 60_000),
  decode: (value) => summary.parse(value),
});
```

One attempt runs run access, verifies the grant against its intent, sends one
request, reduces the Responses stream, reads request status after an ambiguous
loss and closes the execution with its own 10-second bound. Every gateway
identity derives from `taskId` and `attempt`. The deadline, at most one hour
ahead, is part of the execution intent. Tests and consumers can pass their own
`control` and `connectExecution`; the ports are `Pick` types of the clients.

Expected outcomes resolve to `{ ok: false, code, effect, retry }` instead of
throwing. `effect` uses the gateway vocabulary. `retry` is advice only:
`same_attempt` replays the identical task after an ambiguous run access, before
any inference; `new_attempt` uses attempt + 1, and `mayDuplicateCost` marks a
possibly paid previous attempt; `never` needs a changed task or a human.
`cleanup: "pending"` means close was not acknowledged; the grant expires at its
deadline. Exceeding `limits.outputBytes` or `maxOutputTokens` is
`output_truncated`. A decoded value is never trusted from the model alone: JSON
is parsed and `decode` always runs. Failures carry only the safe gateway `traceRef`.

All profiles receive one OpenAI Responses body: stream, store false, service
tier default, `max_output_tokens`, `reasoning` only for an explicit effort, and a
`json_schema` format named `codex_output_schema`. The gateway kernel accepts no
profile above a 1 MiB body, 100 000 output tokens or 8 MiB of output, so larger
tasks fail locally as `invalid_task`; deployments may configure lower limits.
The caller selects the output mode. Native admission at Sub2API `7a20c00` and the
CI pin `a6bc1e36` gives these facts; provider execution of a schema is not
verified for any profile:

| Profile | Native admission | Not verified |
| --- | --- | --- |
| Codex OAuth | requires service tier and `max_output_tokens` (removed before Codex); effort checked against account models | `json_object` |
| Kimi Code, GLM, MiniMax, Grok | `text` or named `json_schema` only; `json_object` and non-null `reasoning` rejected; `max_output_tokens` required | schema enforcement by the provider |
| MiMo | provider rejects `json_schema`; use `json_object` or `text` | `max_output_tokens` acceptance |
| OpenRouter | root allowlist only; format passes through | per-model support |

For Codex OAuth, `model` may name any model of the account's live catalog, for
example `gpt-6.1-sol`, and `effort` must be one of that model's catalog levels.
Both the facade and Native check the request against the catalog. The
enrollment anchor stays `gpt-5.6-sol` in
`oauthEnrollment.modelScope` and the Native `oauth.profile.model`; Native denies
any other anchor at startup, so selecting another model needs neither a
configuration change nor a new device login. While the catalog is explicitly
unavailable, only the anchor is admitted, so a request for another model fails
before dispatch instead of falling back.

`prepareStrictJsonSchema(schema)` is an optional helper for strict providers
such as Codex OAuth. It returns `{ schema, decode }`: every property becomes
required, optional ones accept an added `null`, and objects close with
`additionalProperties: false`. `decode` removes those added nulls and validates
the value against the original schema. Pass `output: { mode: "json_schema",
schema }` and `decode` (optionally chained with the consumer's own parser).
Supported keywords: `$schema` (2020-12), local `$ref`/`$defs`, annotations,
single or nullable `type`, `const`, `enum`, `anyOf`, `oneOf`, `properties`,
`required`, `additionalProperties: false`, single-schema `items`, and the array,
string and number bounds. Anything else throws `LlmSchemaError` with code
`invalid_task` and a path-only detail; a nonconforming output throws
`output_invalid`, which `generate` reports as `output_invalid`.

Every call is one execution, and the gateway accounts it as permanent durable
facts: the execution costs 3 units and its prepare and close operations 1 each.
The request's own unit is released only when `requestReadbackRetentionMs` is
configured. Budget about 5 units per call against three limits: the service
capacity (1 000 000), the consumer limit (default 100 000) and the per-account
limit (default 10 000, about 2 000 calls). Service configuration can only lower
stored limits, so set `durableFacts` before the first start. At a few thousand
calls a day the service capacity lasts weeks to months; monitor consumer and
account fact use. A multi-request session API is deliberately
not part of this entry yet; raising capacity or retaining closed executions is a
gateway decision.

To hand the SDK to a consumer, run `pnpm build`, then
`pnpm --dir packages/account-gateway pack --pack-destination <dir>`. Vendor the
archive with a provenance record: source commit and tree, archive bytes,
SHA-256 and npm `sha512` integrity, package version, Node and pnpm versions,
and the gates that passed on that commit.
