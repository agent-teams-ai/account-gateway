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

The reviewed Get Modular Consumer Module Standard source revision is
8305ea6409757da8e60dca074dce163d95c85e88, full-document SHA-256
3c5814ebf1ab1bd17688e49955aa0baa2ee91dd3a369adcea4d38aaccd53ba86.
The [pending CMS profile](../architecture/consumer-module-adoption.json) and
[full-document delta review](../architecture/evidence/cms-pin-review.json) bind
that exact revision to retained non-authoritative bytes. This pin update reviews
current guidance; it does not activate CMS adoption or upgrade the installed
Core/Assembly 0.2.0 pair. The offline topology gate rejects pin/evidence drift,
and `pnpm test:consumer-pin` checks its TypeScript and rejecting fixtures in both
`test:static` and `test`. These checks qualify document integrity only.
The gate owns the approved revision tuple in code; changing it requires a reviewed pin update.

The 2026-10-25 guidance review changes only Get Modular producer examples to
`bun run` for assembly, resources, conformance and observation checks. Gateway
continues using its own pinned pnpm workspace and qualification commands. This
producer documentation change does not adopt Bun as the Gateway package manager.

The root `tsconfig.json` is the real solution discovery index over SDK emission,
root tests, consumer-pin checks and the private service. SDK emission keeps its
existing options and source/output boundaries in `tsconfig.build.json`; the
existing build script still invokes the pinned official compiler on that project.
Stack checks the three standalone test, pin and service projects separately.
`pnpm check:toolchain-config` rejects missing/duplicate discovery edges, coordinated
service-scope deletion and broadened or weakened SDK emission settings.

Oxlint typed lint discovers `tsconfig.json` and follows project references. Its
[`--tsconfig` flag](https://oxc.rs/docs/guide/usage/linter/cli.html) controls import
resolution and does not select typed-lint programs. Named ordinary projects must
therefore remain reachable through this solution index; inferred error-typed
Node imports are not source-any debt to hide with assertions.

`scripts/consumer-limits-check.mts` remains the unchanged exact-archive consumer
checker owned by `scripts/qualify-consumers.sh`. The private root declares its
public SDK workspace dev dependency, and the existing consumer-pin strict project
owns the whole checker. The SDK build must precede root type and typed-lint checks;
no root typed exclusion or external delegation replaces that ownership.

Fresh NodeNext and ESNext/Bundler archive consumers passed public installed Stack
doctor, whole-checker and generated-closure typechecks, typed lint and the original
runtime assertions. The retained installed Node 26 root result also covers the
whole checker on the reviewed `0ea19fe`-based prepared source. These results bind
their exact source and archive; a changed main tuple requires new validation.
Checkpoint A runs public lint and format checks after SDK emission, and the
configuration guard rejects removing either command or moving them before build.

Current CMS activation remains pending: accept a local adoption decision and exact
boundary/legacy/exception inventory, qualify descriptor/module-entry/group and
`profileId` authoring with the package upgrade, map the current layout to CMS
rules, and add consumer conformance and independent wiring-oracle checks. The
existing four-key `ClientCapabilities` manual map stays valid and unchanged.
When concrete descriptor-derived feature maps are introduced, follow the pinned
standard's complete descriptor unions and separate `CapabilitiesOf` bases; retain
transitive and unused keys and early conflict checks. New composition work must
resolve the profile's pending adoption before claiming current CMS conformance.

Feature Module Standard v1 authority is organization .github commit
eef92e7fd40f538b4e9ba03e01bbd4e2d23f12f2, declared full-byte digest
851653f96643cf0466b67ab22963661976b00de44840fa3144a48a8c054f95fa.
The retained immutable document at organization docs/architecture/feature-module-standard/v1.md was checked against that digest. The scoped
[adoption profile](../architecture/feature-module-adoption.json) classifies
packages/account-gateway as an SDK. Its facade-client feature owns
contracts and HTTP (including private server ingress); get-modular owns optional
module composition. The public indexes are curated export surfaces.
Management and execution factories expose different authorities while sharing
private transport. No product domain model is introduced.

The experimental llm feature owns one bounded model call over those clients:
domain holds the task, result and failure vocabulary; application holds the
attempt lifecycle and its ports. The ports are the facade client capabilities
themselves (`Pick` of the consumer-control and execution clients), so a fake and
the HTTP client share one contract and GatewayError effect semantics. The llm
application imports only facade public entries. Layers are declared per feature
in the adoption profile; one feature's layer name grants nothing to another.

The supported source-dependencies v2 gate owns import parsing, public entrypoint
direction and cycles. The topology gate owns module inventory, feature placement
and empty-layer rejection. Root black-box tests are an explicit ownership
exception over built public entries, reviewed when a third feature or a service
is added. This is bounded
adoption, with native engine and RR excluded; their owners revisit adoption at
B/C/D. Creating another module, layer or dependency requires updating the local
profile and its negative checks.
Boundary inventory: facade contracts (Zod only), facade HTTP (contracts and Zod), curated indexes, optional
composition (HTTP and public Core/Assembly), llm domain (no dependencies), llm
application (llm domain and facade public entries) and the llm index (llm layers
and facade HTTP). Source-dependencies v2 discovers
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
