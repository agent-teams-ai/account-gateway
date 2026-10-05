import pg from 'pg';
import { boundedFacts, KernelError } from './domain.ts';
import { PostgresKernel } from './postgres.ts';
import type { Bounds, DurableFactBounds, DurableKernel, ExecutionRead } from './domain.ts';

// Outermost composition only. Configuration is server-owned; no environment
// discovery, framework, scheduler, credential logging or automatic migration.
// Existing one/two-argument callers remain compatible. Explicit fact bounds are
// captured before acquiring a pool; no qualification is inferred from defaults.
export function openKernel(connectionString: string, bounds?: Bounds, durableFacts?: DurableFactBounds): {
  kernel: DurableKernel & ExecutionRead; shutdown: () => Promise<void>;
} {
  let url: URL;
  try { url = new URL(connectionString); } catch { throw new KernelError('invalid'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.pathname.length < 2) throw new KernelError('invalid');
  const facts = durableFacts === undefined ? undefined : boundedFacts(durableFacts);
  const pool = new pg.Pool({ connectionString, max: 8, connectionTimeoutMillis: 5_000,
    application_name: 'account-gateway-kernel' });
  // Discarded idle connections must not emit raw vendor diagnostics.
  // Transaction failures remain observable through the safe unavailable code.
  pool.on('error', () => undefined);
  return { kernel: new PostgresKernel(pool, bounds, facts), shutdown: () => pool.end() };
}
