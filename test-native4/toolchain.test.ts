import test from 'node:test';
import assert from 'node:assert/strict';
import { qualifyGoPins } from './toolchain.ts';
test('compiler, exact module declaration and fixture guard must agree', () => {
  const module = 'module example.test/native\n\ngo 1.27.3\n';
  const fixture = 'if runtime.Version() != "go1.27.3" { return denied }';
  assert.equal(qualifyGoPins(module, fixture, 'go version go1.27.3 linux/amd64'), 'go1.27.3');
  assert.throws(() => qualifyGoPins(module, fixture.replace('go1.27.3', 'go1.27.1'), 'go version go1.27.3 linux/amd64'), /go-source-contract-conflict/);
  assert.throws(() => qualifyGoPins(module, fixture, 'go version go1.27.4 linux/amd64'), /go-source-contract-conflict/);
  assert.throws(() => qualifyGoPins(module.replace('1.27.3', '1.27'), fixture, 'go version go1.27.3 linux/amd64'), /go-pin-shape/);
});
