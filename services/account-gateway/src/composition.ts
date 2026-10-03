import pg from 'pg';
import { KernelError } from './domain.ts';
import { PostgresKernel } from './postgres.ts';
import type { Bounds, DurableKernel } from './domain.ts';

// Outermost composition only. Configuration is server-owned; no environment
// discovery, framework, scheduler, credential logging or automatic migration.
export function openKernel(connectionString: string, bounds?: Bounds): {
  kernel: DurableKernel; shutdown: () => Promise<void>;
} {
  let url: URL;
  try { url = new URL(connectionString); } catch { throw new KernelError('invalid'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.pathname.length < 2) throw new KernelError('invalid');
  const pool = new pg.Pool({ connectionString, max: 8, connectionTimeoutMillis: 5_000,
    application_name: 'account-gateway-kernel' });
  // Discarded idle connections must not emit raw vendor diagnostics.
  // Transaction failures remain observable through the safe unavailable code.
  pool.on('error', () => undefined);
  return { kernel: new PostgresKernel(pool, bounds), shutdown: () => pool.end() };
}
