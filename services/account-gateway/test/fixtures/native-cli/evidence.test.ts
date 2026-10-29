import test from "node:test";
import assert from "node:assert/strict";
import { goTestEvidence, clientTests } from "./evidence.ts";

void test("Go evidence exports fixed root outcomes and timings while suppressing assertion and client data", () => {
  const name = clientTests[0];
  const sensitive = [
    "Bearer fixture-private-access",
    "fixture-private-refresh",
    "provider-prompt-private",
    "provider-output-private",
    "oauth-state-private",
  ];
  const raw = [
    `=== RUN   ${name}`,
    `    Error: Not equal: expected: ${sensitive[0]}, actual: ${sensitive[1]}`,
    `    credentials: {"access_token":"${sensitive[0]}","refresh_token":"${sensitive[1]}"}`,
    `    native response: {"authorizeURL":"https://example.invalid?state=${sensitive[4]}"}`,
    `    data: {"prompt":"${sensitive[2]}","output":"${sensitive[3]}"}`,
    `CLI stdout: ${sensitive[3]}`,
    `--- PASS: ${name}/provider-output-private (0.1s)`,
    `--- PASS: TestProvider_output_private (0.1s)`,
    `--- PASS: ${name} (0.1s) provider-output-private`,
    `--- PASS: ${name} (NaNs)`,
    `--- PASS: ${name} (0.1s)\u001b[31m`,
    `--- FAIL: ${name} (1.250s)`,
    `--- SKIP: ${clientTests[1]} (0.00s)`,
    "FAIL",
  ].join("\n");
  const evidence = goTestEvidence(raw, clientTests);
  assert.deepEqual(evidence.tests, [
    { name, outcome: "FAIL", seconds: 1.25 },
    { name: clientTests[1], outcome: "SKIP", seconds: 0 },
  ]);
  const exported = JSON.stringify(evidence);
  for (const value of sensitive) {
    assert.equal(exported.includes(value), false);
  }
  assert.deepEqual(goTestEvidence(`--- PASS: ${name} (0.01s)\r\nPASS\r\n`, clientTests).tests, [
    { name, outcome: "PASS", seconds: 0.01 },
  ]);
});
