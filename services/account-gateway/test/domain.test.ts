import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedConfig, defaults, KernelError } from '../src/domain.ts';

// Red if invalid runtime config can widen admission or create unbounded leases.
test('bounds reject zero, fractions, nonfinite values and independent hard ceilings', () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, 86_400_001]) {
    assert.throws(() => boundedConfig({ ...defaults, maxRunMs: value }), KernelError);
  }
  assert.throws(() => boundedConfig({ ...defaults, extra: 1 } as typeof defaults), KernelError);
  assert.throws(() => boundedConfig({ ...defaults, cleanupLeaseMs: 300_001 }), KernelError);
  assert.throws(() => boundedConfig({ ...defaults, maxRequests: 300, maxConcurrent: 129 }), KernelError);
  assert.throws(() => boundedConfig({ ...defaults, maxRequests: 32, maxConcurrent: 33 }), KernelError);
  assert.equal(boundedConfig({ ...defaults, maxRequests: 300, maxConcurrent: 128 }).maxConcurrent, 128);
  assert.throws(() => boundedConfig({ ...defaults, maintenanceBatch: 1_001 }), KernelError);
  assert.throws(() => boundedConfig({ ...defaults, maxRequestBytes: 16_777_217 }), KernelError);
  assert.throws(() => boundedConfig({ ...defaults, maxOutputBytes: NaN }), KernelError);
  assert.throws(() => boundedConfig({ ...defaults, maxTokens: 1.5 }), KernelError);
  assert.equal(boundedConfig({ ...defaults, maxRequests: 2, maxConcurrent: 2 }).maxConcurrent, 2);
});
// Red if later caller mutation can change limits after kernel construction.
test('configured bounds are a frozen value copy', () => {
  const input = { ...defaults };
  const copy = boundedConfig(input);
  input.maxRequests = 999;
  assert.equal(copy.maxRequests, 32);
  assert.equal(Object.isFrozen(copy), true);
});
