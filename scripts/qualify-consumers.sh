#!/usr/bin/env bash
set -euo pipefail
# Controller supplies an absolute archive and a NEW writable disposable directory.
archive=$(realpath "$1")
source_root=$(pwd -P)
node_executable=$(node -p 'process.execPath')
qualification_root=$("$node_executable" "$(dirname "${BASH_SOURCE[0]}")/qualify-whole-consumer.ts" destination "$2")
export PATH="$(dirname "$node_executable"):$PATH"
case "$qualification_root/" in "$source_root/"*) echo 'Use a directory outside the source workspace' >&2; exit 2;; esac
if [ -e "$qualification_root" ]; then echo 'Qualification directory must be absent' >&2; exit 2; fi
mkdir -p "$qualification_root/a" "$qualification_root/b"
for consumer in a b; do
  cp scripts/consumer-check.mjs "$qualification_root/$consumer/consumer-check.mjs"
  cp scripts/consumer-limits-check.mts "$qualification_root/$consumer/consumer-limits-check.mts"
  cp tests/client.test.mjs "$qualification_root/$consumer/client.test.mjs"
  (
    cd "$qualification_root/$consumer"
    "$node_executable" "$source_root/scripts/qualify-whole-consumer.ts" prepare "$source_root" "$PWD" "$archive"
    npm install --package-lock-only --engine-strict --ignore-scripts --no-audit --no-fund --cache "$qualification_root/cache"
    npm ci --engine-strict --ignore-scripts --no-audit --no-fund --cache "$qualification_root/cache"
    "$node_executable" consumer-check.mjs
    resolution=NodeNext
    if [ "$consumer" = b ]; then resolution=Bundler; fi
    "$node_executable" "$source_root/scripts/qualify-whole-consumer.ts" qualify "$source_root" "$PWD" "$archive" "$resolution"
  )
done
# One behavioral suite is the primary owner; the second consumer is the independent
# portability/type/export instance. Shared-facade consumer isolation is a separate test.
(
  cd "$qualification_root/a"
  GATEWAY_HTTP=@agent-teams/account-gateway/http GATEWAY_COMPOSITION=@agent-teams/account-gateway/get-modular "$node_executable" --test client.test.mjs
)

"$node_executable" scripts/consumer-isolation.mjs "$qualification_root/a" "$qualification_root/b"
