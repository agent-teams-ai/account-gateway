# Scoped static composition decision

Scope is the new SDK's optional construction entry only. Consumer application
ports and policy stay consumer-owned; safe wire DTOs belong in adapters. The
provided management/execution profiles select explicit Host config and HTTP
client factories. Host config carries credentials only at construction time.
Invalid slots are rejected by Core; missing factories are rejected by Assembly
before any Host or client constructor runs. The Host owns stream cancellation.

Selected installed public packages: Core/Assembly 0.2.0, ESM Node24.21.0,
TypeScript7.0.2 with skipLibCheck false. SDK build/public dependencies are pinned
in pnpm-lock.yaml. Registry provenance comes from the coordinator's installed
seed and its integrity-bearing npm lock; artifact behavior still requires the
exact packed SDK to pass the installed-consumer gate.

Organization authority remains Get Modular common-assembly source contract at
4b56072ec6ca269fb16e3fdf131d31423af804bd, full-byte digest
33b41d5babf0a431c97e8e596a56e6ec1557ba1a0b26d39bf23e13d9a19e1fbd.
Feature Module Standard v1 authority is organization .github commit
eef92e7fd40f538b4e9ba03e01bbd4e2d23f12f2, declared full-byte digest
851653f96643cf0466b67ab22963661976b00de44840fa3144a48a8c054f95fa.
The retained immutable document at organization docs/architecture/feature-module-standard/v1.md was checked against that digest. The scoped
[adoption profile](../architecture/feature-module-adoption.json) classifies
packages/account-gateway as an SDK. Its one real facade-client feature owns
contracts and HTTP (including private server ingress); get-modular owns optional
module composition. The three public indexes are curated export surfaces.
Management and execution factories expose different authorities while sharing
private transport. No product domain model is introduced.

The supported source-dependencies v2 gate owns import parsing, public entrypoint
direction and cycles. The topology gate owns module inventory, feature placement
and empty-layer rejection. Root black-box tests are an explicit ownership
exception, reviewed when another feature or service is added. This is bounded
adoption, with native engine and RR excluded; their owners revisit adoption at
B/C/D. Creating another module, layer or dependency requires updating the local
profile and its negative checks.
Boundary inventory: facade contracts (Zod only), facade HTTP (contracts and Zod), curated indexes, optional
composition (HTTP and public Core/Assembly). Source-dependencies v2 discovers
unowned roots under the governed SDK root and rejects forbidden imports,
including type-only imports. Source policy, curated package exports and dev-only
Foundation guard are the executable local checks. No independent import parser
is introduced. Tests use an independent HTTP expectation table, not another
production construction path. Exact-archive consumers must exercise public
exports and factory parity, never source aliases.

RR service/domain/UI/CI and native Sub2API are not adopted in this repository.
Their owners activate those seams at B/C/D with native mapping, product
membership and runner qualification. No production second-product integration
is claimed by the two disposable consumer fixtures.

Documentation uses the repository portable v4 profile with authoring v3 over
actual docs/ and the SDK README under packages/. Sidecar metadata preserves
bootstrap first-slice prose; the documentation index reaches authored documents.
AGENTS routes documentation work to the installed portable skill. New-document
preview/apply and stale-preimage tests exercise the same unchanged profile.

The root README and AGENTS remain bootstrap-owned inputs outside the catalog.
Docs Protocol 0.6.2 cannot express a repository-root file collection: a file root
requires a directory, and dot roots are rejected. This is an explicit adoption
limit, not repository-wide document coverage. Revisit when the supported tool
adds root-file catalogs; do not change its parser or provide a substitute check.
