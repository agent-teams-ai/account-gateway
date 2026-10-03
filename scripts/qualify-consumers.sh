#!/usr/bin/env bash
set -euo pipefail
# Controller supplies an absolute archive and a NEW writable disposable directory.
archive=$(realpath "$1")
qualification_root=$(realpath -m "$2")
source_root=$(pwd)
case "$qualification_root/" in "$source_root/"*) echo 'Use a directory outside the source workspace' >&2; exit 2;; esac
if [ -e "$qualification_root" ]; then echo 'Qualification directory must be absent' >&2; exit 2; fi
mkdir -p "$qualification_root/a" "$qualification_root/b"
for consumer in a b; do
  cp scripts/consumer-check.mjs "$qualification_root/$consumer/consumer-check.mjs"
  cp tests/client.test.mjs "$qualification_root/$consumer/client.test.mjs"
  (
    cd "$qualification_root/$consumer"
    node -e 'require("node:fs").writeFileSync("package.json",JSON.stringify({private:true,type:"module"}))'
    npm install --ignore-scripts --no-audit --no-fund --cache "$qualification_root/cache" "$archive" typescript@7.0.2 @types/node@24.19.1
    node consumer-check.mjs
  )
done
# One behavioral suite is the primary owner; the second consumer is the independent
# portability/type/export instance. Shared-facade consumer isolation is a separate test.
(
  cd "$qualification_root/a"
  GATEWAY_HTTP=@agent-teams/account-gateway/http GATEWAY_COMPOSITION=@agent-teams/account-gateway/get-modular node --test client.test.mjs
)

node scripts/consumer-isolation.mjs "$qualification_root/a" "$qualification_root/b"
