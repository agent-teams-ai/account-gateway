import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
const moduleFor = (root) => import(pathToFileURL(resolve(root, "compiled/closure.mjs")).href);
const [a, b] = await Promise.all(process.argv.slice(2).map(moduleFor));
const server = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.headers.authorization === "Bearer consumer-a" && req.url === "/v1/accounts/account-a") {
    res.end(
      JSON.stringify({
        accountRef: "account-a",
        ownerRef: "owner-a",
        profileId: "mimo",
        displayName: "Sandbox",
        state: "active",
        metadataRevision: 1,
        authorizationEpoch: 1,
      }),
    );
  } else if (
    req.headers.authorization === "Bearer consumer-a" &&
    req.url === "/v2/accounts/account-a"
  ) {
    assert.equal(
      req.headers["x-account-gateway-capability"],
      "account-gateway/account-lifecycle/v2",
    );
    assert.equal(
      req.headers["x-account-gateway-client-contract"],
      "account-gateway-client/account-lifecycle/v2",
    );
    res.end(
      JSON.stringify({
        accountRef: "account-a",
        ownerRef: "owner-a",
        profileId: "mimo",
        displayName: "Sandbox",
        state: "active",
        metadataRevision: 1,
        authorizationEpoch: 1,
        authKind: "api_key",
        resumeCustody: "not_applicable",
      }),
    );
  } else {
    assert.equal(req.headers.authorization, "Bearer consumer-b");
    res.statusCode = 404;
    res.end(
      JSON.stringify({
        code: "not_found",
        traceRef: "trace-a",
        effect: "not_dispatched",
        retry: { kind: "never" },
      }),
    );
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  const own = a.readerFor({ origin, role: "management", token: "consumer-a" });
  const foreign = b.readerFor({ origin, role: "management", token: "consumer-b" });
  assert.equal(await a.readOwnedConnection(own, "account-a", "owner-a"), "account-a");
  const lifecycle = a.lifecycleReaderFor({ origin, role: "management", token: "consumer-a" });
  assert.equal(await a.readOwnedConnection(lifecycle, "account-a", "owner-a"), "account-a");
  const foreignLifecycle = b.lifecycleReaderFor({
    origin,
    role: "management",
    token: "consumer-b",
  });
  await assert.rejects(
    b.readOwnedConnection(foreignLifecycle, "account-a", "owner-a"),
    (error) => error.code === "safe_error" && error.diagnostic.code === "not_found",
  );
  await assert.rejects(
    a.readOwnedConnection(own, "account-a", "owner-b"),
    /Connection owner mismatch/,
  );
  await assert.rejects(
    b.readOwnedConnection(foreign, "account-a", "owner-a"),
    (error) => error.code === "safe_error" && error.diagnostic.code === "not_found",
  );
  console.log(
    "PASS two installed clients preserve separate authenticated namespaces against disposable fixture (not native service isolation)",
  );
} finally {
  server.closeAllConnections();
  server.close();
}
