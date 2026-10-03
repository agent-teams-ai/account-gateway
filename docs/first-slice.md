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
Lost acknowledgements use safe readback, never automatic mutation/inference
retry. Readback excludes credentials and provider payloads; uncertain effects
fence the invocation even when a caller supplies another request identity.

The first useful product checkpoint requires MiMo tools, final parsed review and
approved-head publication in disposable CI repositories. Passing SDK fixtures
does not establish native account identity, persistence, tenant isolation,
capacity or product E2E readiness.

Hosted coding jobs return verified patches and evidence. Subsequent jobs use
gpt-6.1-sol with default service tier; exact-code PR review uses xhigh effort.
No production cutover, old-pool retirement or public package release is included
in this repository bootstrap.
