---
name: docs-authoring
description: Create and maintain repository documentation using the portable Docs Protocol layout.
---

# Documentation authoring

Protocol declaration: agent-teams.docs-protocol/v1.

Read `docs.config.yaml` and the local authority files before changing documentation.
Choose the Diataxis category matching the reader's need, or use an ADR for a durable decision.

1. Discover existing material with `docs-protocol find --consumer . --profile docs.config.yaml --text QUERY`.
2. Preview creation with `docs-protocol new --consumer . --profile docs.config.yaml --type TYPE --id ID --title "TITLE" --owner OWNER_ID --summary "SUMMARY" --dry-run`.
3. Apply the reviewed Plan with `docs-protocol new --consumer . --profile docs.config.yaml --type TYPE --id ID --title "TITLE" --owner OWNER_ID --summary "SUMMARY" --apply --expect sha256:PLAN_DIGEST_FROM_DRY_RUN`. Use the exact digest returned by the new-document preview.
4. If the result is `manual-required`, add its exact `markdownLink` to its exact `indexPath` before verification.
5. Refresh bounded agent context with `docs-protocol context --consumer . --profile docs.config.yaml`.
6. Verify authorities and documents with `docs-protocol check --consumer . --profile docs.config.yaml`.

Start from the matching template in `.docs-protocol/templates` and replace every placeholder.
Keep metadata valid against `.docs-protocol/metadata.schema.json` and select a declared owner.
Create files only and never overwrite an existing document for a new-document request.
Do not assume a package manager, hosting provider, or repository forge.
