import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
rmSync("packages/account-gateway/dist", { recursive: true, force: true });
const result = spawnSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"],
  { stdio: "inherit" },
);
process.exitCode = result.status ?? 1;
