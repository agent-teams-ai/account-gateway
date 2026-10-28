import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

await test(
  "borrowed client fatal errors remain unavailable and discard clients through commit handoff",
  { timeout: 12_000 },
  async () => {
    // An asynchronous EventEmitter error without a listener terminates this
    // child process. A query rejection alone cannot reproduce that pg boundary.
    const program = `
      import assert from 'node:assert/strict';
      import { EventEmitter } from 'node:events';
      import { PostgresKernel } from ${JSON.stringify(new URL("../src/postgres.ts", import.meta.url).href)};
      import { KernelError } from ${JSON.stringify(new URL("../src/domain.ts", import.meta.url).href)};
      const worker = '11111111-1111-4111-8111-111111111111';
      const issuer = '22222222-2222-4222-8222-222222222222';
      const lease = new Date('2099-01-01T00:00:00.000Z');
      for (const mode of ['query-reject', 'body-resolve', 'commit-resolve', 'healthy']) {
        const queries = [], releases = [];
        let connects = 0;
        class Client extends EventEmitter {
          async query(sql) {
            queries.push(sql);
            const result = sql.startsWith('SELECT issuer') ? { rows: [{ issuer, worker_slots: 16 }] }
              : sql.startsWith('SELECT lease_until') ? { rows: [{ lease_until: lease }] }
              : { rows: [] };
            if (mode === 'query-reject' && sql.startsWith('INSERT INTO issuer_epochs') ||
                mode === 'body-resolve' && sql.startsWith('SELECT lease_until') ||
                mode === 'commit-resolve' && sql === 'COMMIT') {
              return new Promise((resolve, reject) => setImmediate(() => {
                const error = new Error('Connection terminated unexpectedly');
                this.emit('error', error);
                // Even an already resolving query must not hide a fatal event.
                if (mode === 'query-reject') reject(error); else resolve(result);
              }));
            }
            return result;
          }
          release(discard) {
            // The transaction retains event ownership through pool handoff.
            assert.equal(this.listenerCount('error'), mode === 'healthy' ? 2 : 1);
            releases.push(discard);
          }
        }
        const client = new Client(), existing = () => {};
        if (mode === 'healthy') client.on('error', existing);
        const pool = { async connect() { connects++; return client; } };
        const kernel = new PostgresKernel(pool);
        if (mode === 'healthy') {
          assert.equal(await kernel.currentWorkerLease({ consumerId: 'connection-error-fixture' }, worker), lease.toISOString());
          assert.deepEqual(releases, [false]);
          assert.equal(queries.filter(sql => sql === 'COMMIT').length, 1);
          assert.deepEqual(client.listeners('error'), [existing]);
        } else {
          await assert.rejects(kernel.currentWorkerLease({ consumerId: 'connection-error-fixture' }, worker),
            error => error instanceof KernelError && error.code === 'unavailable' && error.message === 'unavailable');
          assert.deepEqual(releases, [true]);
          assert.equal(queries.includes('COMMIT'), mode === 'commit-resolve');
          assert.equal(queries.includes('ROLLBACK'), false);
          assert.equal(client.listenerCount('error'), 0);
        }
        assert.equal(connects, 1, 'no automatic transaction retry');
        assert.equal(queries.some(sql => /\\b(?:DROP|DELETE|TRUNCATE)\\b/i.test(sql)), false);
      }
      process.stdout.write('borrowed-client-error PASS\\n');
    `;
    const result = await promisify(execFile)(
      process.execPath,
      ["--input-type=module", "--eval", program],
      { timeout: 8000, maxBuffer: 16_384, env: { PATH: process.env.PATH } },
    );
    assert.equal(result.stdout, "borrowed-client-error PASS\n");
    assert.equal(result.stderr, "");
  },
);

await test("persisted operation JSON is whitelisted, nullable replay survives and malformed lifecycle rolls back", async () => {
  // A finite pg protocol stub exercises the actual adapter without a DSN. It
  // qualifies readback/refusal behavior only; SQL/race qualification stays in CI.
  const program = `
    import assert from 'node:assert/strict';
    import { EventEmitter } from 'node:events';
    import { PostgresKernel } from ${JSON.stringify(new URL("../src/postgres.ts", import.meta.url).href)};
    import { KernelError } from ${JSON.stringify(new URL("../src/domain.ts", import.meta.url).href)};
    const account = '11111111-1111-4111-8111-111111111111';
    const issuer = '22222222-2222-4222-8222-222222222222';
    const context = { consumerId: 'row-contract-fixture' };
    const snapshot = { accountRef: account, ownerRef: 'owner', profile: 'profile',
      displayName: '', state: 'suspended', revision: 2, epoch: 3 };
    const base = { id: 'operation', state: 'applied', code: '', account_ref: account,
      execution_ref: null, revision: 0, epoch: 0, deadline: null,
      intent: {}, lifecycle_result: null };
    function fixture(row) {
      const queries = [], releases = [];
      let connects = 0;
      class Client extends EventEmitter {
        async query(sql) {
          queries.push(sql);
          const rows = sql.startsWith('SELECT issuer') ? [{ issuer, worker_slots: 16 }]
            : sql.startsWith('SELECT * FROM operations') ? [row] : [];
          return { rows, rowCount: rows.length };
        }
        release(discard) { releases.push(discard); }
      }
      const client = new Client();
      return { kernel: new PostgresKernel({ async connect() { connects++; return client; } }),
        queries, releases, connects: () => connects };
    }
    const expected = { operationRef: 'operation', state: 'applied', accountRef: account };
    for (const intent of [{}, null]) {
      const f = fixture({ ...base, intent });
      assert.deepEqual(await f.kernel.operation(context, 'operation'), expected);
      assert.equal(f.queries.at(-1), 'COMMIT');
      assert.deepEqual(f.releases, [false]);
    }
    const oauth = fixture({ ...base, intent: { kind: 'create', oauthMethod: 'device_code' } });
    assert.deepEqual(await oauth.kernel.operation(context, 'operation'), { ...expected, oauthMethod: 'device_code' });
    for (const kind of ['suspend', 'resume']) {
      const f = fixture({ ...base, intent: { kind, expectedRevision: 0 },
        lifecycle_result: { ...snapshot, ignoredPrivateField: 'must-not-escape' } });
      assert.deepEqual(await f.kernel.operation(context, 'operation'), { ...expected,
        lifecycle: { kind, expectedRevision: 0, account: snapshot } });
      assert.equal(f.queries.at(-1), 'COMMIT');
    }
    // SQL length counts Unicode characters; JS UTF-16 length must not reject a
    // schema-admitted legacy snapshot at its actual column limits.
    const unicode = { ...snapshot, ownerRef: '😀'.repeat(128), profile: '😀'.repeat(64), displayName: '😀'.repeat(160) };
    const nonAscii = fixture({ ...base, intent: { kind: 'suspend', expectedRevision: 0 }, lifecycle_result: unicode });
    assert.deepEqual((await nonAscii.kernel.operation(context, 'operation')).lifecycle.account, unicode);
    const valid = { ...base, intent: { kind: 'suspend', expectedRevision: 0 }, lifecycle_result: snapshot };
    const invalid = [
      { ...valid, intent: null },
      { ...valid, intent: { kind: 'rename', expectedRevision: 0 } },
      { ...valid, intent: { kind: 'suspend' } },
      { ...valid, intent: { kind: 'suspend', expectedRevision: -1 } },
      { ...valid, intent: { kind: 'suspend', expectedRevision: 0.5 } },
      { ...valid, lifecycle_result: [] },
      { ...valid, lifecycle_result: 'private-vendor-detail' },
      { ...valid, lifecycle_result: { ...snapshot, accountRef: issuer } },
      { ...valid, lifecycle_result: { ...snapshot, ownerRef: null } },
      { ...valid, lifecycle_result: { ...snapshot, profile: '' } },
      { ...valid, lifecycle_result: { ...snapshot, displayName: 5 } },
      { ...valid, lifecycle_result: { ...snapshot, state: 'invented' } },
      { ...valid, lifecycle_result: { ...snapshot, revision: 0 } },
      { ...valid, lifecycle_result: { ...snapshot, epoch: Number.MAX_SAFE_INTEGER + 1 } },
    ];
    for (const row of invalid) {
      const f = fixture(row);
      await assert.rejects(f.kernel.operation(context, 'operation'),
        error => error instanceof KernelError && error.code === 'unavailable' && error.message === 'unavailable');
      assert.equal(f.queries.at(-1), 'ROLLBACK');
      assert.equal(f.queries.includes('COMMIT'), false);
      assert.equal(f.connects(), 1);
      assert.deepEqual(f.releases, [false]);
    }
    const proof = { executionRef: account, requestRef: 'request', worker: issuer, token: account,
      native: { originRef: 'origin', engineIncarnation: issuer, requestNonce: account, generation: issuer } };
    for (const entered of [true, 0, null, undefined, 'false']) {
      const f = fixture(base);
      await assert.rejects(f.kernel.rejectBeforeDispatch(context, issuer, proof, entered),
        error => error instanceof KernelError && error.code === 'invalid');
      assert.equal(f.connects(), 0);
    }
    for (const native of [null, 0, 'not-a-proof']) {
      const f = fixture(base);
      await assert.rejects(f.kernel.acknowledgeTransportClosed(context, issuer, { ...proof, native }),
        error => error instanceof KernelError && error.code === 'invalid');
      assert.equal(f.connects(), 0);
    }
    const malformed = fixture(base);
    await assert.rejects(malformed.kernel.claim(context, account, 'request', issuer, {}, null),
      error => error instanceof KernelError && error.code === 'invalid');
    assert.equal(malformed.connects(), 0);
    process.stdout.write('persisted-operation-boundary PASS\\n');
  `;
  const result = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "--eval", program],
    { timeout: 8000, maxBuffer: 16_384, env: { PATH: process.env.PATH } },
  );
  assert.equal(result.stdout, "persisted-operation-boundary PASS\n");
  assert.equal(result.stderr, "");
});
