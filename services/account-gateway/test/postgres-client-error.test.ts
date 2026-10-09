import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('borrowed client fatal error is unavailable, discards the client and cannot commit or crash the process',
  { timeout: 12_000 }, async () => {
    // An asynchronous EventEmitter error without a listener terminates this
    // child process. A query rejection alone cannot reproduce that pg boundary.
    const program = `
      import assert from 'node:assert/strict';
      import { EventEmitter } from 'node:events';
      import { PostgresKernel } from ${JSON.stringify(new URL('../src/postgres.ts', import.meta.url).href)};
      import { KernelError } from ${JSON.stringify(new URL('../src/domain.ts', import.meta.url).href)};
      const worker = '11111111-1111-4111-8111-111111111111';
      const issuer = '22222222-2222-4222-8222-222222222222';
      const lease = new Date('2099-01-01T00:00:00.000Z');
      for (const mode of ['query-reject', 'body-resolve', 'healthy']) {
        const queries = [], releases = [];
        let connects = 0;
        class Client extends EventEmitter {
          async query(sql) {
            queries.push(sql);
            const result = sql.startsWith('SELECT issuer') ? { rows: [{ issuer }] }
              : sql.startsWith('SELECT lease_until') ? { rows: [{ lease_until: lease }] }
              : { rows: [] };
            if (mode === 'query-reject' && sql.startsWith('INSERT INTO issuer_epochs') ||
                mode === 'body-resolve' && sql.startsWith('SELECT lease_until')) {
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
          assert.equal(queries.includes('COMMIT'), false);
          assert.equal(queries.includes('ROLLBACK'), false);
          assert.equal(client.listenerCount('error'), 0);
        }
        assert.equal(connects, 1, 'no automatic transaction retry');
        assert.equal(queries.some(sql => /\\b(?:DROP|DELETE|TRUNCATE)\\b/i.test(sql)), false);
      }
      process.stdout.write('borrowed-client-error PASS\\n');
    `;
    const result = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', program],
      { timeout: 8000, maxBuffer: 16_384, env: { PATH: process.env.PATH } });
    assert.equal(result.stdout, 'borrowed-client-error PASS\n');
    assert.equal(result.stderr, '');
  });
