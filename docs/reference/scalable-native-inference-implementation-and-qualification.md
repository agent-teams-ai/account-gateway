---
id: docs.reference.scalable-native-inference
type: reference
status: proposed
owner: gateway-maintainers
summary: Approved staged implementation, safety invariants and evidence for a Go inference path with TypeScript control.
---

# Scalable native inference implementation and qualification

## Overview

The owner approved implementation on 2026-10-23: keep TypeScript SDK and account
control, move public inference bytes, provider adaptation, streaming and
cancellation to the existing Go engine, and qualify the complete path. Changes
are staged in dependent branches in account-gateway and sub2api; production
deployment and public package publication are outside this implementation.

The baseline is account-gateway f3e061d and native b813197. The prior qualification
used an API-key controlled provider, sixteen occupied streams and brief arrival
steps. It does not establish Codex/Claude OAuth or thousand-stream capacity.

Three implementation owners cover SQL, native Claude resource lifetime, and
public Go inference/capabilities. The integration owner maintains configuration,
full-stack load qualification, publication and independent final review.

## Contract

### Invariants

- A persisted current execution, account generation, policy fence, issuer and
  worker lease authorize each dispatch. Public clients never receive private
  native peer credentials, descriptors or closure proofs.
- One atomic durable claim and native entry CAS govern each original request.
  Inference has no hidden retry, provider failover or replay after ambiguity.
- Expiry, cancellation and revoke cannot erase an accepted unknown effect or
  release transport occupancy without exact physical closure evidence.
- Provider credentials and request/response bodies are absent from diagnostics.
- Public data admission and private control retain independent finite bounds.
  Capacity settings are operator inputs; only measured profiles are qualified.
- Historical SQL migration checksums remain unchanged. The lock-order migration
  requires old kernel writers to stop before application.

### Implementation sequence

1. Release Claude physical SQL guards after response headers and staged passive
   limit capture, before the SSE body pump. Preserve revision-checked cache write,
   physical stream ownership and cancellation. Prove progress with four SQL
   connections and at least five concurrent controlled-provider streams.
2. Replace heavyweight read transactions with read-only consistent snapshots;
   combine dispatch reads; acquire the global budget only for actual charging or
   tightening. The new consumer-before-budget order must cover direct triggers,
   first-consumer creation and every mutation without a reverse lock edge.
3. Replace per-process accumulation of execution bearer records with stable,
   purpose-separated authenticated execution locators. Bind issuer identity,
   consumer, execution, original admission tuple and expiry; revalidate durable
   current state on use and preserve safe original readback.
4. Add a separate bounded Go public listener. Metadata-only authenticated
   callbacks provide current execution authority, durable claim and terminal
   settlement. Go owns request bytes, response backpressure and physical closure;
   failed settlement retains original evidence for existing cleanup recovery.
   The legacy private transport and TS execution path remain compatible.
5. Qualify standard client protocol adapters explicitly. A Responses-to-Messages
   upstream adapter is not itself a public Anthropic Messages API. SDK inference
   origin is separate from control origin and accepts only explicitly configured
   transport policy.
6. Address continuous-operation retention with expiring replay namespaces and
   irreversible retirement fences before reclaiming positively settled history.
   Unknown effects and occupied transport proofs remain retained. Increasing a
   counter ceiling or deleting arbitrary old request IDs is not a solution.
7. Run production assembly, higher-concurrency and sustained workload scenarios,
   then independent exact-source critics and repairs. Preserve all failures and
   distinguish offered, accepted, refused, canceled and completed requests.

### Qualification gates

Use pinned Node 26.11.1 and compatibility Node 24.21.0, Go 1.27.3 and disposable
PostgreSQL 17.10. Reuse the frozen dependency lockfiles. Tests use sandbox accounts
and controlled TLS providers; external provider traffic is not a load fixture.

Required evidence covers protocol compatibility, duplicate/revoked/expired
capabilities, cross-consumer SQL progress, final-slot budget conservation, slow
readers, cancel, owner loss, settlement recovery and clean process/DB retirement.
Scale profiles report concurrent streams, offered and accepted request rate,
payload bytes, response duration, CPU/RSS scope, event-loop delay, SQL waits and
cleanup time. Long contexts and continuous create/close churn are separate axes.

## Examples

The SDK sends account and lifecycle controls to its configured TypeScript origin
and inference to its explicitly configured Go inference origin. A production
edge router may expose one external origin while preserving separate internal
listeners. A client request cannot select a native/provider URL.

At an illustrative twenty-second mean response time, one thousand continuously
occupied sequential agents mean about fifty new requests per second and one
thousand streams. One thousand new requests per second instead mean about twenty
thousand streams. Neither scenario is qualified by the baseline sixteen-slot run.

## Evidence status

Implementation in progress. No new scale, OAuth, CLI or production capacity claim
is made by this plan checkpoint. Final source pins, commands, results, remaining
limits and review dispositions will replace this status as qualification lands.
