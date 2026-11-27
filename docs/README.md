---
id: docs.index.documentation
type: index
status: active
owner: gateway-maintainers
summary: Repository documentation and scoped authority.
---
# Documentation

- [Repository entry](../README.md)
- [First-slice contract scope](first-slice.md)
- [Composition and feature adoption](COMPOSITION.md)
- [SDK usage](../packages/account-gateway/README.md)
- [Checkpoint A handoff](HANDOFF.md)

Run pnpm docs:check from the root. Portable v4 and authoring v3 govern this
corpus and package documentation through the root docs.config.yaml.

## Choose a task

| Task | Start here |
| --- | --- |
| Integrate the server SDK | [SDK usage](../packages/account-gateway/README.md), [first-slice scope](first-slice.md) |
| Understand service ownership and composition | [Composition](COMPOSITION.md), [repository entry](../README.md) |
| Change native account contracts | [Native account contracts](reference/native-account-contracts.md), [integration plan](reference/native-account-integration-plan.md), [provider profiles](reference/native-account-provider-profiles.md) |
| Integrate the native backend or a consumer | [Native account gateway](reference/native-account-gateway.md), [Sub2API](reference/native-account-sub2api.md), [Review Router](reference/native-account-review-router.md) |
| Qualify inference, account behavior or load | [Implementation and qualification](reference/scalable-native-inference-implementation-and-qualification.md), [account qualification](reference/native-account-qualification.md), [cloud load qualification](reference/cloud-load-qualification.md) |
| Review earlier decisions or findings | [Account review log](reference/native-account-review-log.md), [SDK review fixes](SDK-REVIEW-FIXES.md) |

## Historical handoffs

These source-bound records are useful for tracing earlier patches and reviews, not as a current implementation checklist. Do not treat an old handoff as present qualification.

- [Checkpoint A](HANDOFF.md)
- [Facade patch](../FACADE_HANDOFF.md)
- [Native assembly](../NATIVE_ASSEMBLY_HANDOFF.md)
- [Native bridge](../NATIVE_BRIDGE_HANDOFF.md)
- [Run access](../RUN_ACCESS_HANDOFF.md)
- [Service entry](../SERVICE_ENTRY_HANDOFF.md)

## Document organization

The [reference collection](reference/) owns the maintained native-account documents and qualification references. New artifacts follow the [local authoring skill](.agents/skills/docs-authoring/SKILL.md) and the declared profile; do not invent artifact types or move historical records solely for cosmetic consistency. Keep this navigation separate from accepted contracts, proposed plans and source-bound evidence.
