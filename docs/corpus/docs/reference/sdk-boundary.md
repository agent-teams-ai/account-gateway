---
id: docs.reference.sdk-boundary
type: reference
status: proposed
owner: gateway-maintainers
summary: Safe v1 wire contracts, server-only clients and passive static composition.
---

# SDK boundary

## Overview

The SDK implements the private v1 facade contract; native service and product authority remain separate checkpoints.

## Contract

Management submission is write-only. Readback has strict safe result unions and stable caller identities. Transport ambiguity fences reconciliation; clients never replay automatically.

## Examples

Consumer application ports remain independent. An outer adapter uses /http; the Host passes server-owned configuration privately to /get-modular construction.
