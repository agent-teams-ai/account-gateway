import test from 'node:test';
import assert from 'node:assert/strict';
import { qualifyTap } from './tap.ts';
const passing = `TAP version 13
# Subtest: independent observable behavior
ok 1 - independent observable behavior
  ---
  duration_ms: 2.4
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 4.3
`;
test('ordinary complete zero-skip zero-todo TAP is accepted', () => {
  assert.deepEqual(qualifyTap(passing), { tests: 1 });
});
test('unqualified and incomplete TAP is rejected', () => {
  const cases = [
    passing.replace('ok 1 -', 'ok 1 # SKIP -'),
    passing.replace('ok 1 -', 'ok 1 # TODO -'),
    passing.replace('# skipped 0', '# skipped 1'),
    passing.replace('# todo 0', '# todo 1'),
    passing.replace('# fail 0', '# fail 1'),
    passing.replace('# cancelled 0', '# cancelled 1'),
    passing.replace('# pass 1', '# pass 0'),
    passing.replace('# skipped 0\n', ''),
    passing.replace('# tests 1', '# tests 0'),
    passing.replace('1..1', '1..0'),
    passing.replace('1..1', '1..2'),
    passing.replace('ok 1 -', 'not ok 1 -'),
    passing.replace('# duration_ms 4.3\n', ''),
    passing.slice(0, passing.indexOf('# tests')),
    passing + '# tests 1\n',
    passing.replace('ok 1 -', 'ok 2 -'),
  ];
  for (const candidate of cases) assert.throws(() => qualifyTap(candidate), /suite-incomplete/);
});
