# First slice

The implementation target is the accepted Review Router Account Gateway
first-slice contract (architecture document 52, revised 2026-10-03).

This bootstrap implements only the SDK: one versioned wire-schema authority,
server-only HTTP clients and static Get Modular composition. The intended
repository ownership includes a private Sub2API facade, but its implementation,
native integration and service kernel remain pending, as do Review Router
service/domain/UI integration and product CI qualification. This ownership is
normative scope, not evidence of completed delivery. Consumer products keep
their own users, membership and repository policies.

Operation references equal stable caller operation IDs in the authenticated
consumer namespace. Request references equal caller request IDs per execution.
Preparation retains opaque string invocation/attempt references and independent
policy and repository-binding revisions. An unknown request status cannot assert
absence of dispatch; completed status requires a completed effect. Cancellation
can retain an accepted effect. The service must persist and enforce this envelope.
Lost acknowledgements use safe readback, never automatic mutation/inference
retry. Readback excludes credentials and provider payloads; uncertain effects
fence the invocation even when a caller supplies another request identity.

Applied preparation results require the safe gateway-selected `accountRef` and
`authorizationEpoch` alongside `executionRef`, deadline and state. The single
feature-owned `executionResult` schema validates both preparation acknowledgement
and operation GET. The gateway must return the same persisted selected tuple on
both paths, including after a lost acknowledgement from a multi-account approved
set. Consumer policy builds admission from that tuple and its saved preparation
intent (profile, subject, policy/binding revisions, limits and deadline); it must
not infer the pinned epoch from current account metadata. Readback does not expose
private admission, native descriptors, credentials or provider bodies.

The selected-identity HTTP regression uses a two-account approved set, an applied
acknowledgement, a later applied operation GET and a lost acknowledgement recovered
by a fresh client. Its loopback request checks admission hydration and request
counts. Malformed selected fields and private extras fail with caller operation
identity and `effect_unknown`, without automatic preparation/inference retry or
secret diagnostics. These fixtures establish SDK behavior only.

Hosted qualification on 2026-10-03 passed frozen installation, build, all 25
tests, Foundation/Docs/topology gates and both fresh installed archive consumers
(public exports and TypeScript closure, copied HTTP suite and separate-consumer
isolation). The applied-result HTTP regression failed against the previous
schema and passed after the correction. Receipt:
`qualification-sdk-selected-4d252de0-v1`, bound to the guarded code patch
`4d252de0aa0a129402977dc9309cb9bf8eff0dcb11f6622ce61c9f1d3b886ae3`.
Both installed consumers assert the selected result contract at the public
schema boundary and compile a discriminated operation-to-selected-identity
projection. These results qualify SDK behavior, not the actual service.
B must independently test the actual authenticated facade plus migrated database:
select from two approved accounts, observe the physical account/epoch pinned,
lose the preparation acknowledgement, and recover the identical tuple through
operation GET and saved consumer intent. Race reconnect before and after
preparation; stale epochs must deny dispatch with zero replacement inference.
Actual persistence/restart recovery, namespace/role denial, claim/fence races,
accepted-effect preservation and native identity proof still need their own
facade/DB/native receipts. No fixture establishes these gates or live provider,
RR CI, capacity or production acceptance.

The first useful product checkpoint requires MiMo tools, final parsed review and
approved-head publication in disposable CI repositories. Passing SDK fixtures
does not establish native account identity, persistence, tenant isolation,
capacity or product E2E readiness.

Hosted coding jobs return verified patches and evidence. Subsequent jobs use
gpt-6.1-sol with default service tier; exact-code PR review uses xhigh effort.
No production cutover, old-pool retirement or public package release is included
in this repository bootstrap.
