import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { ServiceAdmission, sharedCheckout, inServiceLane } from '../src/service-admission.ts';

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
function client(released: (error?: Error | boolean) => void): PoolClient {
  return { release: released } as PoolClient;
}

test('one physical owner bounds waiting data and leaves actual clients for control', async () => {
  let connects = 0;
  const pool = { connect: async () => { connects++; return client(() => undefined); } } as unknown as Pool;
  const kernelCheckout = sharedCheckout(pool), storeCheckout = sharedCheckout(pool);
  assert.equal(kernelCheckout, storeCheckout);
  const held = await Promise.all(Array.from({ length: 6 }, () => kernelCheckout()));
  const waiting = Array.from({ length: 8 }, () => storeCheckout().then(c => c.release()));
  await assert.rejects(storeCheckout());
  assert.equal(connects, 6); // Neither queued nor denied work entered pool.connect.
  const controls = await inServiceLane('control', () => Promise.all([storeCheckout(), kernelCheckout()]));
  assert.equal(connects, 8);
  controls.forEach(c => c.release()); held.forEach(c => c.release());
  await Promise.all(waiting);
});

test('timed out connect keeps its slot until late client release, exactly once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending: ((value: PoolClient) => void)[] = [];
  const pool = { connect: () => new Promise<PoolClient>(resolve => pending.push(resolve)) } as unknown as Pool;
  const checkout = sharedCheckout(pool);
  const acquisitions = Array.from({ length: 6 }, () => checkout());
  const denied = Promise.all(acquisitions.map(p => assert.rejects(p)));
  assert.equal(pending.length, 6);
  t.mock.timers.tick(5001); await denied;
  const waiting = checkout(); await flush();
  assert.equal(pending.length, 6); // Logical timeouts did not recycle physical slots.
  let releases = 0;
  pending[0](client(() => { releases++; })); await flush();
  assert.equal(releases, 1); assert.equal(pending.length, 7);
  const lateFlags: (Error | boolean | undefined)[] = [];
  pending[6](client(error => lateFlags.push(error)));
  const borrowed = await waiting;
  borrowed.release(true); borrowed.release();
  assert.deepEqual(lateFlags, [true]);
  pending.slice(1, 6).forEach(resolve => resolve(client(() => { releases++; })));
  await flush(); assert.equal(releases, 6);
});

test('shutdown waits for the retained handler reservation and denies new work', async () => {
  const admission = new ServiceAdmission();
  const release = admission.reserve('data'); assert.ok(release);
  let stopped = false;
  const drain = admission.stop().then(() => { stopped = true; });
  await flush(); assert.equal(stopped, false);
  assert.equal(admission.reserve('control'), undefined);
  release(); await drain; assert.equal(stopped, true);
  release(); // Repeated cleanup cannot underflow the ownership count.
});
