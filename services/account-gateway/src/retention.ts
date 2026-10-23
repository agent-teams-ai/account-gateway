import type { PoolClient } from 'pg';

// Execution/prepare tombstones remain permanent replay namespaces. Request
// details only expire for explicitly opted-in executions with bound v2 native
// nonces, positive terminal effects, exact ACKs and completed cleanup. Legacy,
// uncertain and occupied evidence never retires. Expired detail readback is
// unknown; the irreversible namespace marker denies every future claim.
//
// Redundant JSON intent expires at the numeric approved deadline, conditional on
// a non-open execution, positive terminal effects, exact closure and durable done
// cleanup. Pending recovery has no finite TTL. In particular maxRunMs alone is
// not a deletion horizon, and lease expiry is never evidence of closure.
// Caller holds the kernel consumer transaction lock. All mutation is
// within that transaction, so a fence/restore/claim cannot race the safety test.
export async function compactSafePayloads(db: PoolClient, consumer: string, batch: number): Promise<void> {
  await db.query(`WITH safe AS MATERIALIZED (
    SELECT e.ref FROM executions e WHERE e.consumer=$1 AND e.state<>'open'
      AND e.deadline<=clock_timestamp()
      AND (e.intent IS NOT NULL OR EXISTS (SELECT 1 FROM operations o
        WHERE o.consumer=e.consumer AND o.execution_ref=e.ref AND o.intent IS NOT NULL))
      AND EXISTS (SELECT 1 FROM cleanup j WHERE j.consumer=e.consumer AND j.execution_ref=e.ref AND j.state='done')
      AND NOT EXISTS (SELECT 1 FROM requests r WHERE r.consumer=e.consumer AND r.execution_ref=e.ref
        AND (r.transport_occupied OR r.effect NOT IN ('not_dispatched','completed','rejected_before_dispatch')))
      AND NOT EXISTS (SELECT 1 FROM cleanup j LEFT JOIN candidates c
        ON c.consumer=j.consumer AND c.generation=j.generation
        LEFT JOIN executions x ON x.consumer=j.consumer AND x.ref=j.execution_ref
        WHERE j.consumer=e.consumer AND j.state<>'done'
          AND (c.account_ref=e.account_ref OR x.account_ref=e.account_ref))
      AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.consumer=e.consumer AND o.state IN ('pending','unknown')
        AND (o.account_ref=e.account_ref OR o.intent->>'kind'='fence'))
      ORDER BY e.deadline,e.ref LIMIT $2
    ), compact_operations AS (
      UPDATE operations o SET intent=NULL FROM safe s WHERE o.consumer=$1 AND o.execution_ref=s.ref
        AND o.state IN ('applied','rejected') AND o.intent IS NOT NULL RETURNING o.id
    ) UPDATE executions e SET intent=NULL FROM safe s WHERE e.consumer=$1 AND e.ref=s.ref AND e.intent IS NOT NULL`,
  [consumer, batch]);
  // SQL marks one eligible namespace irreversibly, then removes at most batch
  // request rows and their usage revisions. It refunds only those request units
  // under consumer/account -> service-budget order. Other tombstones stay charged.
  await db.query('SELECT retire_closed_request_details($1,$2)', [consumer, batch]);
}
