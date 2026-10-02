# Account Gateway

Private, reusable account gateway backed by a pinned Sub2API engine.

The gateway owns upstream credentials, account mapping and execution effects.
Consumers own their users, workspace authorization and product workflows.
The server-only TypeScript SDK exposes versioned contracts, HTTP capabilities
and a static Get Modular composition entry.

Implementation is in progress. There is no qualified deployment or published
SDK yet. Review Router's accepted first-slice plan is the implementation input;
completion requires actual CLI tools, final review and publication in disposable
CI repositories, alongside lifecycle and isolation checks.

No old-pool credential/history migration, personal account sharing or generic
agent scheduler belongs to the initial slice.
