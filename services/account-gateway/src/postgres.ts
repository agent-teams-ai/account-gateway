import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  KernelError, boundedConfig, boundedFacts, approvedLimits, defaults, factDefaults, identifier, integer, revision as authorityRevision, uuid, instant,
} from './domain.ts';
import type {
  TrustedContext, DurableKernel, Bounds, DurableFactBounds, AccountIntent, AccountStatus, OperationStatus,
  ApprovedPreparation, ExecutionStatus, NativeDescriptor, NativeCreatePermit,
  PrivateAdmission, ApprovedLimits, AccountPageQuery, AccountPage, ClaimResult, RequestStatus, Effect, CleanupClaim, TransportClosure, CleanupAuthority, NativeReservation, NativeDispatchProof, NativeBinding,
} from './domain.ts';
import { compactSafePayloads } from './retention.ts';
import { sharedCheckout } from './service-admission.ts';
import type { Checkout } from './service-admission.ts';

type Row = Record<string, any>;
type Tx = { db: PoolClient; consumer: string; issuer: string };
const operationStatus = (r: Row): OperationStatus => ({
  operationRef: r.id, state: r.state, ...(r.code ? { code: r.code } : {}),
  ...(r.account_ref ? { accountRef: r.account_ref } : {}),
  ...(r.execution_ref ? { executionRef: r.execution_ref } : {}),
  ...(r.revision ? { revision: r.revision } : {}), ...(r.epoch ? { epoch: r.epoch } : {}),
  ...(r.deadline ? { deadline: r.deadline.toISOString() } : {}),
});
const requestStatus = (r: Row): RequestStatus => ({
  requestRef: r.id, effect: r.effect, ...(r.code ? { code: r.code } : {}),
});
const descriptor = (r: Row): NativeDescriptor => ({
  generation: r.generation, nativePhysicalIdentity: r.native_identity, profile: r.profile,
});

const accountStatus = (r: Row): AccountStatus => ({
  accountRef: r.ref, ownerRef: r.owner_ref, profile: r.profile, displayName: r.display_name,
  state: r.state, revision: r.revision, epoch: r.epoch,
});
const executionLimits = (r: Row): ApprovedLimits => ({
  requests: r.max_requests, concurrency: r.max_concurrent, requestBytes: r.max_request_bytes,
  outputBytes: r.max_output_bytes, tokens: r.max_tokens,
});

const nativeBinding = (r: Row): NativeBinding => ({
  originRef: r.native_origin_ref, engineIncarnation: r.engine_incarnation,
  requestNonce: r.request_nonce, generation: r.descriptor_generation,
});
const transportClosure = (r: Row): TransportClosure => ({
  executionRef: r.execution_ref, requestRef: r.id, worker: r.worker,
  ...(r.closure_token ? { token: r.closure_token } : {}),
  ...(r.native_origin_ref !== null && r.native_origin_ref !== undefined ? { native: nativeBinding(r) } : {}),
});
const captureReservation = (input: NativeReservation): NativeReservation => {
  if (!input || typeof input !== 'object') throw new KernelError('invalid');
  const copy = { originRef: input.originRef, engineIncarnation: input.engineIncarnation, requestNonce: input.requestNonce };
  identifier(copy.originRef); uuid(copy.engineIncarnation); uuid(copy.requestNonce);
  return copy;
};
const captureClosure = (proof: TransportClosure): TransportClosure => {
  if (!proof || typeof proof !== 'object') throw new KernelError('invalid');
  const native = proof.native;
  return { executionRef: proof.executionRef, requestRef: proof.requestRef, worker: proof.worker, token: proof.token,
    ...(native === undefined ? {} : { native: { ...captureReservation(native), generation: native.generation } }) };
};
const validateNativeClosure = (proof: TransportClosure): void => {
  uuid(proof.executionRef); identifier(proof.requestRef); uuid(proof.worker); uuid(proof.token);
  uuid(proof.native?.generation);
  // Native fields were independently validated by captureReservation. A legacy
  // NULL binding has no authority, even when an older closure token exists.
};
const dispatchProof = (r: Row): NativeDispatchProof => ({
  executionRef: r.execution_ref, requestRef: r.id, worker: r.worker, token: r.closure_token,
  native: nativeBinding(r),
});

// One consumer row is the explicit serialization lock for policy fences,
// account routes and execution claims. No native calls occur inside transactions.
// This intentionally trades per-consumer throughput for a small auditable kernel.
export class PostgresKernel implements DurableKernel {
  private readonly checkout: Checkout;
  private readonly bounds: Readonly<Bounds>;
  private readonly facts: Readonly<DurableFactBounds>;
  constructor(pool: Pool, bounds: Bounds = defaults, facts: DurableFactBounds = factDefaults) {
    this.checkout = sharedCheckout(pool);
    this.bounds = boundedConfig(bounds);
    this.facts = boundedFacts(facts);
  }
  private async transaction<T>(context: TrustedContext, body: (tx: Tx) => Promise<T>): Promise<T> {
    const consumer = context.consumerId;
    identifier(consumer);
    let db: PoolClient | undefined;
    let clientFailed = false;
    const onClientError = (): void => { clientFailed = true; };
    try {
      db = await this.checkout();
      // Pool error handlers cover idle clients; this transaction owns the
      // borrowed client's fatal error event until release installs that handler.
      db.on('error', onClientError);
      await db.query('BEGIN');
      await db.query('SET LOCAL search_path = ag_kernel, pg_catalog');
      // Global final-slot accounting has one explicit lock order: budget, then
      // consumer. Limits may tighten, never silently reopen saturated history.
      await db.query('SELECT singleton FROM fact_budget WHERE singleton FOR UPDATE');
      await db.query('UPDATE fact_budget SET capacity=least(capacity,$1) WHERE singleton', [this.facts.maxServiceFacts]);
      await db.query(`INSERT INTO consumers(consumer,fact_limit,account_fact_limit,worker_slots,issuer_slots)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [consumer, this.facts.maxConsumerFacts, this.facts.maxAccountFacts, this.facts.workerSlots, this.facts.issuerSlots]);
      const r = await db.query('SELECT issuer FROM consumers WHERE consumer=$1 FOR UPDATE', [consumer]);
      await db.query(`UPDATE consumers SET fact_limit=least(fact_limit,$2),account_fact_limit=least(account_fact_limit,$3)
        WHERE consumer=$1`, [consumer, this.facts.maxConsumerFacts, this.facts.maxAccountFacts]);
      await db.query('INSERT INTO issuer_epochs(consumer,issuer) VALUES ($1,$2) ON CONFLICT DO NOTHING', [consumer, r.rows[0].issuer]);
      const result = await body({ db, consumer, issuer: r.rows[0].issuer });
      if (clientFailed) throw new KernelError('unavailable');
      await db.query('COMMIT');
      if (clientFailed) throw new KernelError('unavailable');
      return result;
    } catch (error) {
      if (db && !clientFailed) await db.query('ROLLBACK').catch(() => undefined);
      if (clientFailed) throw new KernelError('unavailable');
      if (error instanceof KernelError) throw error;
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '54000') throw new KernelError('denied');
      // Never export vendor exception bodies, query parameters or connection data.
      throw new KernelError('unavailable');
    } finally {
      if (db) {
        try { db.release(clientFailed); }
        finally { db.removeListener('error', onClientError); }
      }
    }
  }
  private async one(tx: Tx, sql: string, values: readonly unknown[]): Promise<Row> {
    const r = await tx.db.query(sql, [...values]);
    if (!r.rows[0]) throw new KernelError('unknown');
    return r.rows[0];
  }
  private async existing(tx: Tx, id: string, intent: object): Promise<OperationStatus | undefined> {
    const r = await tx.db.query(`SELECT *, intent_hash=sha256(convert_to($3::jsonb::text,'UTF8')) AS matches
      FROM operations WHERE consumer=$1 AND id=$2`,
      [tx.consumer, id, JSON.stringify(intent)]);
    if (!r.rows[0]) return undefined;
    if (!r.rows[0].matches) throw new KernelError('conflict');
    return operationStatus(r.rows[0]);
  }
  private async insertOperation(tx: Tx, id: string, intent: object, account?: string, execution?: string): Promise<void> {
    await tx.db.query(`INSERT INTO operations(consumer,id,intent,state,account_ref,execution_ref)
      VALUES ($1,$2,$3::jsonb,'pending',$4,$5)`,
    [tx.consumer, id, JSON.stringify(intent), account ?? null, execution ?? null]);
  }
  private async op(tx: Tx, id: string): Promise<OperationStatus> {
    return operationStatus(await this.one(tx, 'SELECT * FROM operations WHERE consumer=$1 AND id=$2', [tx.consumer, id]));
  }
  private async worker(tx: Tx, worker: string): Promise<void> {
    uuid(worker);
    const r = await tx.db.query('SELECT 1 FROM workers WHERE consumer=$1 AND worker=$2 AND lease_until>clock_timestamp()',
      [tx.consumer, worker]);
    if (!r.rowCount) throw new KernelError('denied');
  }
  private async cleanup(tx: Tx, generation?: string, execution?: string): Promise<void> {
    await tx.db.query(`INSERT INTO cleanup(consumer,generation,execution_ref) VALUES ($1,$2,$3)
      ON CONFLICT DO NOTHING`, [tx.consumer, generation ?? null, execution ?? null]);
  }
  private async fenceExecution(tx: Tx, ref: string): Promise<void> {
    await tx.db.query("UPDATE executions SET state='fenced' WHERE consumer=$1 AND ref=$2", [tx.consumer, ref]);
    await this.cleanup(tx, undefined, ref);
  }
  async issuer(context: TrustedContext): Promise<string> { return this.transaction(context, async tx => tx.issuer); }
  async account(context: TrustedContext, ref: string): Promise<AccountStatus> {
    uuid(ref);
    return this.transaction(context, async tx => {
      const r = await this.one(tx, 'SELECT * FROM accounts WHERE consumer=$1 AND ref=$2', [tx.consumer, ref]);
      return accountStatus(r);
    });
  }
  async accounts(context: TrustedContext, query: AccountPageQuery = {}): Promise<AccountPage> {
    const { ownerRef, cursor: after, limit: requestedLimit, allowedOwnerRefs } = query;
    if (ownerRef !== undefined) identifier(ownerRef);
    if (after !== undefined) uuid(after);
    if (allowedOwnerRefs !== undefined && (!Array.isArray(allowedOwnerRefs) || allowedOwnerRefs.length > 100)) throw new KernelError('invalid');
    const owners = allowedOwnerRefs === undefined ? null : Object.freeze([...allowedOwnerRefs]);
    owners?.forEach(value => identifier(value));
    const limit = requestedLimit ?? 100;
    integer(limit, 100);
    // UUID keyset cursor is an ordering boundary, never a foreign-reference lookup.
    const owner = ownerRef ?? null, cursor = after ?? null;
    return this.transaction(context, async tx => {
      const page = await tx.db.query(`SELECT * FROM accounts WHERE consumer=$1
        AND ($2::text IS NULL OR owner_ref=$2) AND ($3::uuid IS NULL OR ref>$3)
        AND ($5::text[] IS NULL OR owner_ref=ANY($5::text[]))
        ORDER BY ref LIMIT $4`, [tx.consumer, owner, cursor, limit + 1, owners]);
      const rows = page.rows.slice(0, limit);
      return { accounts: rows.map(accountStatus),
        ...(page.rows.length > limit ? { nextCursor: rows[rows.length - 1].ref } : {}) };
    });
  }
  async operation(context: TrustedContext, id: string): Promise<OperationStatus> {
    identifier(id);
    return this.transaction(context, tx => this.op(tx, id));
  }
  async beginAccount(context: TrustedContext, input: AccountIntent): Promise<OperationStatus> {
    input = { operationId: input.operationId, kind: input.kind, intentDigest: input.intentDigest,
      accountRef: input.accountRef, expectedRevision: input.expectedRevision,
      ownerRef: input.ownerRef, profile: input.profile, displayName: input.displayName };
    identifier(input.operationId); identifier(input.intentDigest);
    if (!['create','reconnect','rename','disable'].includes(input.kind)) throw new KernelError('invalid');
    if (input.kind === 'create') {
      identifier(input.ownerRef); identifier(input.profile, 64);
      if (input.accountRef !== undefined || input.expectedRevision !== undefined) throw new KernelError('invalid');
    } else {
      uuid(input.accountRef); authorityRevision(input.expectedRevision);
      if (input.ownerRef !== undefined || input.profile !== undefined) throw new KernelError('invalid');
    }
    if (input.kind === 'create' || input.kind === 'rename') {
      if (typeof input.displayName !== 'string' || input.displayName.length > 160) throw new KernelError('invalid');
    } else if (input.displayName !== undefined) throw new KernelError('invalid');
    const intent = { kind: input.kind, digest: input.intentDigest,
      target: input.accountRef ?? null, expectedRevision: input.expectedRevision ?? null,
      owner: input.ownerRef ?? null, profile: input.profile ?? null, name: input.displayName ?? null };
    return this.transaction(context, async tx => {
      const old = await this.existing(tx, input.operationId, intent);
      if (old) return old;
      let a: Row;
      if (input.kind === 'create') {
        a = (await tx.db.query(`INSERT INTO accounts(consumer,ref,owner_ref,profile,display_name,state)
          VALUES ($1,$2,$3,$4,$5,'staging') RETURNING *`,
        [tx.consumer, randomUUID(), input.ownerRef, input.profile, input.displayName])).rows[0];
      } else {
        a = await this.one(tx, 'SELECT * FROM accounts WHERE consumer=$1 AND ref=$2', [tx.consumer, input.accountRef]);
        if (a.revision !== input.expectedRevision) throw new KernelError('conflict');
        if (input.kind === 'reconnect' && !['active','quarantined'].includes(a.state)) throw new KernelError('denied');
      }
      await this.insertOperation(tx, input.operationId, intent, a.ref);
      if (input.kind === 'create' || input.kind === 'reconnect') {
        await tx.db.query(`INSERT INTO candidates(consumer,generation,account_ref,operation_id,profile,
          expected_revision,expected_epoch,old_generation,state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'staged')`,
        [tx.consumer, randomUUID(), a.ref, input.operationId, a.profile, a.revision, a.epoch, a.active_generation]);
      } else {
        const disabled = input.kind === 'disable';
        a = (await tx.db.query(`UPDATE accounts SET display_name=$3, revision=revision+1,
          epoch=epoch+$4, state=$5 WHERE consumer=$1 AND ref=$2 RETURNING *`,
        [tx.consumer, a.ref, input.displayName ?? a.display_name, disabled ? 1 : 0, disabled ? 'disabled' : a.state])).rows[0];
        if (disabled) {
          await tx.db.query(`UPDATE operations o SET state=CASE WHEN c.state='staged' THEN 'rejected' ELSE 'unknown' END,
            code='account_disabled' FROM candidates c WHERE o.consumer=$1 AND c.consumer=o.consumer
            AND c.operation_id=o.id AND c.account_ref=$2 AND o.state='pending'`, [tx.consumer, a.ref]);
          await tx.db.query("UPDATE candidates SET state='quarantined' WHERE consumer=$1 AND account_ref=$2 AND state IN ('staged','creating','ready')",
            [tx.consumer, a.ref]);
          const executions = await tx.db.query("UPDATE executions SET state='fenced' WHERE consumer=$1 AND account_ref=$2 AND state='open' RETURNING ref",
            [tx.consumer, a.ref]);
          for (const e of executions.rows) await this.cleanup(tx, undefined, e.ref);
          const candidates = await tx.db.query('SELECT generation FROM candidates WHERE consumer=$1 AND account_ref=$2',
            [tx.consumer, a.ref]);
          for (const c of candidates.rows) await this.cleanup(tx, c.generation);
        }
        await tx.db.query("UPDATE operations SET state='applied',revision=$3,epoch=$4 WHERE consumer=$1 AND id=$2",
          [tx.consumer, input.operationId, a.revision, a.epoch]);
      }
      return this.op(tx, input.operationId);
    });
  }
  async startCandidate(context: TrustedContext, id: string, worker: string): Promise<NativeCreatePermit | undefined> {
    identifier(id);
    return this.transaction(context, async tx => {
      await this.worker(tx, worker);
      const c = await this.one(tx, 'SELECT * FROM candidates WHERE consumer=$1 AND operation_id=$2', [tx.consumer, id]);
      if (c.state !== 'staged') return undefined; // Never repeat a possibly effected create.
      const a = await this.one(tx, 'SELECT * FROM accounts WHERE consumer=$1 AND ref=$2', [tx.consumer, c.account_ref]);
      if (a.state === 'disabled' || a.revision !== c.expected_revision || a.epoch !== c.expected_epoch) {
        await tx.db.query("UPDATE operations SET state='rejected',code='revision_conflict' WHERE consumer=$1 AND id=$2", [tx.consumer, id]);
        await tx.db.query("UPDATE candidates SET state='quarantined' WHERE consumer=$1 AND generation=$2", [tx.consumer, c.generation]);
        await this.cleanup(tx, c.generation);
        return undefined;
      }
      await tx.db.query("UPDATE candidates SET state='creating',worker=$3 WHERE consumer=$1 AND generation=$2", [tx.consumer, c.generation, worker]);
      return { operationRef: id, candidate: c.generation, profile: c.profile };
    });
  }
  async acknowledgeCandidate(context: TrustedContext, id: string, worker: string, proof: NativeDescriptor): Promise<OperationStatus> {
    // Capture the physical proof before validation and the first await.
    proof = { generation: proof.generation, nativePhysicalIdentity: proof.nativePhysicalIdentity,
      profile: proof.profile };
    identifier(id); uuid(proof.generation); uuid(proof.nativePhysicalIdentity); identifier(proof.profile, 64);
    return this.transaction(context, async tx => {
      await this.worker(tx, worker);
      const c = await this.one(tx, 'SELECT * FROM candidates WHERE consumer=$1 AND operation_id=$2', [tx.consumer, id]);
      if (c.generation !== proof.generation || c.profile !== proof.profile ||
          (c.native_identity && c.native_identity !== proof.nativePhysicalIdentity)) throw new KernelError('conflict');
      const acknowledged = await this.op(tx, id);
      if (acknowledged.state === 'applied' || acknowledged.state === 'rejected') return acknowledged;
      if (c.state === 'ready') return acknowledged;
      // Unknown candidates can only be reconciled by exact physical proof, never startCandidate.
      if (!['creating','quarantined'].includes(c.state)) throw new KernelError('denied');
      if (c.state === 'creating' && c.worker !== worker) throw new KernelError('denied');
      const a = await this.one(tx, 'SELECT * FROM accounts WHERE consumer=$1 AND ref=$2', [tx.consumer, c.account_ref]);
      // Only initial staging birth tolerates metadata rename after its permit.
      // Reconnect still loses metadata CAS; no authority fence is waived.
      const stagingRename = a.state === 'staging' && c.old_generation === null &&
        a.active_generation === null && a.revision >= c.expected_revision;
      const stale = acknowledged.state === 'unknown' || (!stagingRename && a.revision !== c.expected_revision) ||
        a.profile !== c.profile || a.epoch !== c.expected_epoch ||
        a.active_generation !== c.old_generation || c.state === 'quarantined' || !['staging','active','quarantined'].includes(a.state);
      await tx.db.query("UPDATE candidates SET native_identity=$3,state=$4 WHERE consumer=$1 AND generation=$2",
        [tx.consumer, c.generation, proof.nativePhysicalIdentity, stale ? 'quarantined' : 'ready']);
      if (stale) {
        // A consumed candidate with exact physical proof may have effected.
        // Bind cleanup identity and preserve prior unknown/fence classification
        // atomically; it can never become a definitely-not-dispatched rejection.
        await tx.db.query(`UPDATE operations SET state='unknown',code=CASE WHEN state='unknown' THEN code ELSE 'revision_conflict' END
          WHERE consumer=$1 AND id=$2`, [tx.consumer, id]);
        await this.cleanup(tx, c.generation);
      } else {
        const promoted = (await tx.db.query(`UPDATE accounts SET active_generation=$3,state='active',
          revision=revision+1,epoch=epoch+$4 WHERE consumer=$1 AND ref=$2 RETURNING revision,epoch`,
        [tx.consumer, c.account_ref, c.generation, c.old_generation ? 1 : 0])).rows[0];
        await tx.db.query("UPDATE operations SET state='applied',code=NULL,revision=$3,epoch=$4 WHERE consumer=$1 AND id=$2",
          [tx.consumer, id, promoted.revision, promoted.epoch]);
        if (c.old_generation) await this.cleanup(tx, c.old_generation);
        const es = await tx.db.query(`UPDATE executions SET state='fenced' WHERE consumer=$1 AND account_ref=$2
          AND account_epoch<>$3 AND state='open' RETURNING ref`, [tx.consumer, c.account_ref, promoted.epoch]);
        for (const e of es.rows) await this.cleanup(tx, undefined, e.ref);
      }
      return this.op(tx, id);
    });
  }
  async unknownCandidate(context: TrustedContext, id: string, worker: string): Promise<OperationStatus> {
    identifier(id);
    return this.transaction(context, async tx => {
      const c = await this.one(tx, 'SELECT * FROM candidates WHERE consumer=$1 AND operation_id=$2', [tx.consumer, id]);
      if (['ready','retired','quarantined'].includes(c.state)) return this.op(tx, id);
      if (c.worker !== worker || c.state !== 'creating') throw new KernelError('denied');
      await this.quarantineCandidate(tx, c);
      return this.op(tx, id);
    });
  }
  private async quarantineCandidate(tx: Tx, c: Row): Promise<void> {
    await tx.db.query("UPDATE candidates SET state='quarantined' WHERE consumer=$1 AND generation=$2", [tx.consumer, c.generation]);
    await tx.db.query("UPDATE operations SET state='unknown',code='native_ack_unknown' WHERE consumer=$1 AND id=$2", [tx.consumer, c.operation_id]);
    await tx.db.query("UPDATE accounts SET state='quarantined' WHERE consumer=$1 AND ref=$2 AND state='staging'", [tx.consumer, c.account_ref]);
    await this.cleanup(tx, c.generation);
  }
  async prepare(context: TrustedContext, input: ApprovedPreparation): Promise<OperationStatus> {
    identifier(input.operationId); identifier(input.intentDigest); identifier(input.invocationRef); identifier(input.attemptRef);
    identifier(input.profile, 64); identifier(input.policySubject); uuid(input.issuerEpoch);
    authorityRevision(input.policyRevision); authorityRevision(input.bindingRevision);
    const limits = approvedLimits(input.limits, this.bounds);
    if (!(input.deadline instanceof Date) || !Number.isFinite(input.deadline.getTime()) ||
        !Array.isArray(input.permittedAccounts) || input.permittedAccounts.length < 1 ||
        input.permittedAccounts.length > 16) throw new KernelError('invalid');
    input.permittedAccounts.forEach(uuid);
    // Capture trusted values before the first await; callers cannot widen them mid-transaction.
    input = { ...input, deadline: new Date(input.deadline.getTime()), permittedAccounts: [...input.permittedAccounts], limits };
    const intent = { kind: 'prepare', digest: input.intentDigest, invocation: input.invocationRef, attemptRef: input.attemptRef,
      permitted: input.permittedAccounts, profile: input.profile, subject: input.policySubject,
      policyRevision: input.policyRevision, bindingRevision: input.bindingRevision, issuer: input.issuerEpoch,
      deadline: input.deadline.toISOString(), limits };
    return this.transaction(context, async tx => {
      const old = await this.existing(tx, input.operationId, intent);
      if (old) return old;
      const sticky = await tx.db.query(`SELECT *,intent_hash=sha256(convert_to($4::jsonb::text,'UTF8')) AS matches
        FROM executions WHERE consumer=$1 AND invocation=$2 AND attempt_ref=$3`,
        [tx.consumer, input.invocationRef, input.attemptRef, JSON.stringify(intent)]);
      let e = sticky.rows[0];
      if (e && !e.matches) throw new KernelError('conflict');
      if (!e) {
        const now = (await tx.db.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
        if (tx.issuer !== input.issuerEpoch || input.deadline.getTime() <= now.getTime() ||
            input.deadline.getTime() - now.getTime() > this.bounds.maxRunMs) throw new KernelError('denied');
        await tx.db.query('INSERT INTO policy_fences(consumer,subject,revision) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
          [tx.consumer, input.policySubject, input.policyRevision]);
        const f = await this.one(tx, 'SELECT revision FROM policy_fences WHERE consumer=$1 AND subject=$2', [tx.consumer, input.policySubject]);
        if (Number(f.revision) > input.policyRevision) throw new KernelError('denied');
        const a = await tx.db.query(`SELECT a.* FROM accounts a JOIN candidates c ON c.consumer=a.consumer
          AND c.generation=a.active_generation WHERE a.consumer=$1 AND a.ref=ANY($2::uuid[])
          AND a.state='active' AND c.state='ready' AND a.profile=$3
          ORDER BY array_position($2::uuid[],a.ref) LIMIT 1`, [tx.consumer, input.permittedAccounts, input.profile]);
        if (!a.rows[0]) throw new KernelError('unknown');
        const selected = a.rows[0];
        e = (await tx.db.query(`INSERT INTO executions(consumer,ref,invocation,attempt_ref,intent,account_ref,account_epoch,
          generation,policy_subject,policy_revision,issuer,policy_fence,deadline,max_requests,max_concurrent,
          binding_revision,profile,max_request_bytes,max_output_bytes,max_tokens,state)
          VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,
            (SELECT fence FROM policy_fences WHERE consumer=$1 AND subject=$9),$12,$13,$14,$15,$16,$17,$18,$19,'open') RETURNING *`,
        [tx.consumer, randomUUID(), input.invocationRef, input.attemptRef, JSON.stringify(intent), selected.ref,
          selected.epoch, selected.active_generation, input.policySubject, input.policyRevision,
          input.issuerEpoch, input.deadline, limits.requests, limits.concurrency, input.bindingRevision, input.profile,
          limits.requestBytes, limits.outputBytes, limits.tokens])).rows[0];
      }
      await this.insertOperation(tx, input.operationId, intent, e.account_ref, e.ref);
      await tx.db.query("UPDATE operations SET state='applied',epoch=$3,deadline=$4 WHERE consumer=$1 AND id=$2",
        [tx.consumer, input.operationId, e.account_epoch, e.deadline]);
      return this.op(tx, input.operationId);
    });
  }
  async execution(context: TrustedContext, ref: string): Promise<ExecutionStatus> {
    uuid(ref);
    return this.transaction(context, async tx => {
      const e = await this.one(tx, 'SELECT * FROM executions WHERE consumer=$1 AND ref=$2', [tx.consumer, ref]);
      return { executionRef: e.ref, accountRef: e.account_ref, epoch: e.account_epoch,
        state: e.state, deadline: e.deadline.toISOString() };
    });
  }
  async request(context: TrustedContext, ref: string, id: string): Promise<RequestStatus> {
    uuid(ref); identifier(id);
    return this.transaction(context, async tx => requestStatus(await this.one(tx,
      'SELECT * FROM requests WHERE consumer=$1 AND execution_ref=$2 AND id=$3', [tx.consumer, ref, id])));
  }
  async savedExecution(context: TrustedContext, ref: string): Promise<import('./domain.ts').SavedExecution> {
    uuid(ref);
    return this.transaction(context, async tx => {
      const e = await this.one(tx, `SELECT e.*, (e.state='open' AND e.issuer=$3
        AND e.deadline>clock_timestamp() AND a.state='active' AND a.epoch=e.account_epoch
        AND a.active_generation=e.generation AND a.profile=e.profile AND c.state='ready' AND c.profile=e.profile
        AND (f.revision<e.policy_revision OR (f.revision=e.policy_revision AND f.fence=e.policy_fence))) AS allowed
        FROM executions e JOIN accounts a ON a.consumer=e.consumer AND a.ref=e.account_ref
        JOIN candidates c ON c.consumer=e.consumer AND c.generation=e.generation
        JOIN policy_fences f ON f.consumer=e.consumer AND f.subject=e.policy_subject
        WHERE e.consumer=$1 AND e.ref=$2`, [tx.consumer, ref, tx.issuer]);
      return { generation: e.generation, state: e.state, dispatchAllowed: e.allowed === true, admission: {
        executionRef: e.ref, issuerEpoch: e.issuer, invocationRef: e.invocation, attemptRef: e.attempt_ref,
        accountRef: e.account_ref, authorizationEpoch: e.account_epoch, subjectRef: e.policy_subject,
        policyRevision: Number(e.policy_revision), bindingRevision: Number(e.binding_revision), profileId: e.profile,
        limits: executionLimits(e), expiresAt: e.deadline.toISOString(),
      } };
    });
  }
  async currentWorkerLease(context: TrustedContext, worker: string): Promise<string> {
    uuid(worker);
    return this.transaction(context, async tx => {
      const r = await this.one(tx, `SELECT lease_until FROM workers WHERE consumer=$1 AND worker=$2
        AND lease_until>clock_timestamp()`, [tx.consumer, worker]);
      return r.lease_until.toISOString();
    });
  }
  async requestProof(context: TrustedContext, ref: string, id: string): Promise<NativeDispatchProof | undefined> {
    uuid(ref); identifier(id);
    return this.transaction(context, async tx => {
      const r = await this.one(tx, `SELECT execution_ref,id,worker,closure_token,native_origin_ref,
        engine_incarnation,request_nonce,descriptor_generation FROM requests
        WHERE consumer=$1 AND execution_ref=$2 AND id=$3`, [tx.consumer, ref, id]);
      return r.closure_token && r.native_origin_ref && r.engine_incarnation && r.request_nonce && r.descriptor_generation
        ? dispatchProof(r) : undefined;
    });
  }
  async claim(context: TrustedContext, ref: string, id: string, worker: string, admission: PrivateAdmission, reservation: NativeReservation): Promise<ClaimResult> {
    // Capture whitelisted primitives before validation or any await.
    reservation = captureReservation(reservation);
    admission = { executionRef: admission.executionRef, issuerEpoch: admission.issuerEpoch,
      invocationRef: admission.invocationRef, attemptRef: admission.attemptRef, accountRef: admission.accountRef,
      authorizationEpoch: admission.authorizationEpoch, subjectRef: admission.subjectRef,
      policyRevision: admission.policyRevision, bindingRevision: admission.bindingRevision, profileId: admission.profileId,
      expiresAt: admission.expiresAt, limits: { requests: admission.limits.requests, concurrency: admission.limits.concurrency,
        requestBytes: admission.limits.requestBytes, outputBytes: admission.limits.outputBytes, tokens: admission.limits.tokens } };
    uuid(ref); identifier(id); uuid(worker); uuid(admission.issuerEpoch);
    uuid(admission.executionRef); uuid(admission.accountRef); identifier(admission.subjectRef);
    identifier(admission.invocationRef); identifier(admission.attemptRef); identifier(admission.profileId, 64);
    authorityRevision(admission.authorizationEpoch); authorityRevision(admission.policyRevision); authorityRevision(admission.bindingRevision);
    if (typeof admission.expiresAt !== 'string') throw new KernelError('invalid');
    const expiresAt = new Date(admission.expiresAt).getTime();
    if (!Number.isFinite(expiresAt)) throw new KernelError('invalid');
    // Date truncates finer fractions. Only exactly representable millisecond
    // instants may match a persisted Date; extra trailing zeroes are equivalent.
    const fraction = admission.expiresAt.match(/\.(\d+)/)?.[1] ?? '';
    const exactExpiry = !/[1-9]/.test(fraction.slice(3));
    admission = { ...admission, limits: approvedLimits(admission.limits, this.bounds) };
    return this.transaction(context, async tx => {
      const previous = await tx.db.query('SELECT * FROM requests WHERE consumer=$1 AND execution_ref=$2 AND id=$3',
        [tx.consumer, ref, id]);
      if (previous.rows[0]) return { status: requestStatus(previous.rows[0]) };
      const e = await this.one(tx, 'SELECT * FROM executions WHERE consumer=$1 AND ref=$2', [tx.consumer, ref]);
      // All generations/states of this consumer/account share occupancy. The
      // hard ceiling is 128; overfull legacy accounts remain conservatively denied.
      const ownerLost = await this.reconcileRequests(tx, ref, 128, e.account_ref);
      const a = await this.one(tx, 'SELECT * FROM accounts WHERE consumer=$1 AND ref=$2', [tx.consumer, e.account_ref]);
      const c = await this.one(tx, 'SELECT * FROM candidates WHERE consumer=$1 AND generation=$2', [tx.consumer, e.generation]);
      const f = await this.one(tx, 'SELECT revision,fence FROM policy_fences WHERE consumer=$1 AND subject=$2', [tx.consumer, e.policy_subject]);
      const now = (await tx.db.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
      let code: string | undefined;
      if (ownerLost || admission.executionRef !== ref || admission.accountRef !== e.account_ref ||
          admission.subjectRef !== e.policy_subject || e.state !== 'open' || e.issuer !== tx.issuer || admission.issuerEpoch !== e.issuer ||
          a.state !== 'active' || a.epoch !== e.account_epoch || admission.authorizationEpoch !== e.account_epoch ||
          a.active_generation !== e.generation || c.state !== 'ready' ||
          admission.invocationRef !== e.invocation || admission.attemptRef !== e.attempt_ref ||
          admission.profileId !== e.profile || a.profile !== e.profile || c.profile !== e.profile ||
          admission.policyRevision !== Number(e.policy_revision) || admission.bindingRevision !== Number(e.binding_revision) ||
          !exactExpiry || expiresAt !== e.deadline.getTime() || admission.limits.requests !== e.max_requests ||
          admission.limits.concurrency !== e.max_concurrent || admission.limits.requestBytes !== e.max_request_bytes ||
          admission.limits.outputBytes !== e.max_output_bytes || admission.limits.tokens !== e.max_tokens ||
          Number(f.revision) > Number(e.policy_revision) ||
          (Number(f.revision) === Number(e.policy_revision) && f.fence !== e.policy_fence)) code = 'fenced';
      else if (e.deadline.getTime() <= now.getTime()) {
        code = 'deadline';
        await tx.db.query("UPDATE executions SET state='closed' WHERE consumer=$1 AND ref=$2", [tx.consumer, ref]);
        await this.cleanup(tx, undefined, ref);
      } else {
        const occupied = (await tx.db.query(`SELECT count(*)::integer AS account_n,
          count(*) FILTER (WHERE r.execution_ref=$2)::integer AS execution_n
          FROM requests r JOIN executions x ON x.consumer=r.consumer AND x.ref=r.execution_ref
          WHERE r.consumer=$1 AND x.account_ref=$3 AND r.transport_occupied`, [tx.consumer, ref, e.account_ref])).rows[0];
        if (e.request_count >= e.max_requests || occupied.execution_n >= e.max_concurrent ||
            occupied.account_n >= this.bounds.maxConcurrent) code = 'limit';
      }
      if (!code) {
        await this.worker(tx, worker);
        // One native reservation nonce cannot be moved onto a fresh request ID.
        // The consumer lock serializes this check; SQL003 independently guards it.
        const reused = await tx.db.query(`SELECT 1 FROM requests WHERE consumer=$1
          AND native_origin_ref=$2 AND engine_incarnation=$3 AND request_nonce=$4 LIMIT 1`,
        [tx.consumer, reservation.originRef, reservation.engineIncarnation, reservation.requestNonce]);
        if (reused.rowCount) throw new KernelError('denied');
      }
      const r = (await tx.db.query(`INSERT INTO requests(consumer,execution_ref,id,effect,code,worker,transport_occupied,closure_token,
        native_origin_ref,engine_incarnation,request_nonce,descriptor_generation)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [tx.consumer, ref, id,
        code ? 'not_dispatched' : 'dispatch_started', code ?? null, code ? null : worker, !code, code ? null : randomUUID(),
        code ? null : reservation.originRef, code ? null : reservation.engineIncarnation,
        code ? null : reservation.requestNonce, code ? null : e.generation])).rows[0];
      if (code) return { status: requestStatus(r) };
      await tx.db.query('UPDATE executions SET request_count=request_count+1 WHERE consumer=$1 AND ref=$2', [tx.consumer, ref]);
      return { status: requestStatus(r), dispatch: { descriptor: descriptor(c), executionRef: ref, requestRef: id,
        limits: executionLimits(e), deadline: e.deadline.toISOString(), closure: dispatchProof(r) } };
    });
  }
  async effect(context: TrustedContext, ref: string, id: string, worker: string,
    next: Exclude<Effect, 'not_dispatched' | 'dispatch_started' | 'rejected_before_dispatch'>): Promise<RequestStatus> {
    uuid(ref); identifier(id); uuid(worker);
    if (!['response_started','completed','effect_unknown'].includes(next)) throw new KernelError('invalid');
    return this.transaction(context, async tx => {
      const r = await this.one(tx, `SELECT r.*,w.lease_until>clock_timestamp() AS live FROM requests r
        LEFT JOIN workers w ON w.consumer=r.consumer AND w.worker=r.worker
        WHERE r.consumer=$1 AND r.execution_ref=$2 AND r.id=$3`, [tx.consumer, ref, id]);
      if (r.worker !== worker) throw new KernelError('denied');
      // Terminal readback never grants dispatch and accepted completion survives owner loss.
      if (!['dispatch_started','response_started'].includes(r.effect)) {
        if (r.effect === next) return requestStatus(r);
        throw new KernelError('conflict');
      }
      if (r.live) {
        if (next === 'completed' && r.effect !== 'response_started') throw new KernelError('conflict');
        // Recheck at the write, including same-state readback: a lease can expire
        // after the read. Consumer serialization also prevents lease resurrection.
        const changed = (await tx.db.query(`UPDATE requests r SET effect=$4
          WHERE r.consumer=$1 AND r.execution_ref=$2 AND r.id=$3 AND EXISTS
          (SELECT 1 FROM workers w WHERE w.consumer=r.consumer AND w.worker=r.worker
            AND w.lease_until>clock_timestamp()) RETURNING r.*`, [tx.consumer, ref, id, next])).rows[0];
        if (changed) {
          if (next === 'effect_unknown') await this.fenceExecution(tx, ref);
          return requestStatus(changed);
        }
      }
      // Return after committing classification; throwing inside this transaction
      // would roll back both the unknown effect and its durable execution fence.
      const lost = (await tx.db.query(`UPDATE requests SET effect='effect_unknown',code='owner_lost'
        WHERE consumer=$1 AND execution_ref=$2 AND id=$3 RETURNING *`, [tx.consumer, ref, id])).rows[0];
      await this.fenceExecution(tx, ref);
      return requestStatus(lost);
    });
  }
  async rejectBeforeDispatch(context: TrustedContext, worker: string, input: NativeDispatchProof,
    entered: false): Promise<RequestStatus> {
    const proof = captureClosure(input);
    uuid(worker); validateNativeClosure(proof);
    if (entered !== false) throw new KernelError('invalid');
    if (worker !== proof.worker) throw new KernelError('denied');
    return this.transaction(context, async tx => {
      const r = await this.one(tx, 'SELECT * FROM requests WHERE consumer=$1 AND execution_ref=$2 AND id=$3',
        [tx.consumer, proof.executionRef, proof.requestRef]);
      if (r.worker !== proof.worker || r.closure_token !== proof.token ||
          r.native_origin_ref !== proof.native!.originRef || r.engine_incarnation !== proof.native!.engineIncarnation ||
          r.request_nonce !== proof.native!.requestNonce || r.descriptor_generation !== proof.native!.generation) {
        throw new KernelError('denied');
      }
      // Exact terminal readback is harmless after lease loss; it neither grants
      // permission nor rewrites the persisted non-entry fact.
      if (r.effect === 'rejected_before_dispatch') return requestStatus(r);
      if (r.effect !== 'dispatch_started') throw new KernelError('conflict');
      const rejected = (await tx.db.query(`UPDATE requests r SET effect='rejected_before_dispatch',code='native_rejected'
        WHERE r.consumer=$1 AND r.execution_ref=$2 AND r.id=$3 AND r.effect='dispatch_started'
        AND EXISTS (SELECT 1 FROM workers w WHERE w.consumer=r.consumer AND w.worker=r.worker
          AND w.lease_until>clock_timestamp()) RETURNING r.*`,
      [tx.consumer, proof.executionRef, proof.requestRef])).rows[0];
      if (rejected) return requestStatus(rejected);
      // Commit required unknown/fence classification if the original lease was
      // lost, including expiry between the read and the attempted settlement.
      const lost = (await tx.db.query(`UPDATE requests SET effect='effect_unknown',code='owner_lost'
        WHERE consumer=$1 AND execution_ref=$2 AND id=$3 RETURNING *`,
      [tx.consumer, proof.executionRef, proof.requestRef])).rows[0];
      await this.fenceExecution(tx, proof.executionRef);
      return requestStatus(lost);
    });
  }
  async acknowledgeTransportClosed(context: TrustedContext, worker: string, proof: TransportClosure,
    cleanup?: CleanupAuthority): Promise<void> {
    proof = captureClosure(proof);
    cleanup = cleanup === undefined ? undefined : { cleanupRef: cleanup.cleanupRef, token: cleanup.token,
      leaseExpiresAt: cleanup.leaseExpiresAt };
    uuid(worker); validateNativeClosure(proof);
    if (cleanup) { uuid(cleanup.cleanupRef); uuid(cleanup.token); }
    else if (worker !== proof.worker) throw new KernelError('denied');
    // Preserve nanoseconds through the write; timestamptz/Date coercion would
    // round a forged +1ns extension into the genuine stored microsecond lease.
    const declaredLease = cleanup?.leaseExpiresAt === undefined ? null : instant(cleanup.leaseExpiresAt).toString();
    return this.transaction(context, async tx => {
      // Exact immutable request/owner/token match. A cleanup delegate additionally
      // needs its exact leased execution scope at the write; generation erasure
      // cannot release occupancy. Repeated exact owner acks remain harmless.
      const closed = await tx.db.query(`UPDATE requests r SET transport_occupied=false
        WHERE r.consumer=$1 AND r.execution_ref=$2 AND r.id=$3 AND r.worker=$4 AND r.closure_token=$5
        AND r.native_origin_ref=$9 AND r.engine_incarnation=$10 AND r.request_nonce=$11 AND r.descriptor_generation=$12
        AND ($6::uuid IS NULL OR EXISTS (SELECT 1 FROM cleanup j WHERE j.consumer=r.consumer
          AND j.ref=$6 AND j.execution_ref=r.execution_ref AND j.worker=$7 AND j.token=$8
          AND ($13::numeric IS NULL OR extract(epoch FROM j.lease_until)*1000000000=$13::numeric)
          AND ((j.state='claimed' AND j.lease_until>clock_timestamp())
            OR (j.state='done' AND NOT r.transport_occupied)))) RETURNING r.id`,
      [tx.consumer, proof.executionRef, proof.requestRef, proof.worker, proof.token,
        cleanup?.cleanupRef ?? null, worker, cleanup?.token ?? null, proof.native!.originRef,
        proof.native!.engineIncarnation, proof.native!.requestNonce, proof.native!.generation, declaredLease]);
      if (!closed.rowCount) throw new KernelError('denied');
      // Closure is independent of accepted effect. If owner loss has not yet been
      // observed, classify this exact request before committing the release.
      const lost = await tx.db.query(`UPDATE requests r SET effect='effect_unknown',code='owner_lost'
        WHERE r.consumer=$1 AND r.execution_ref=$2 AND r.id=$3
        AND r.effect IN ('dispatch_started','response_started') AND NOT EXISTS
          (SELECT 1 FROM workers w WHERE w.consumer=r.consumer AND w.worker=r.worker
            AND w.lease_until>clock_timestamp()) RETURNING r.id`,
      [tx.consumer, proof.executionRef, proof.requestRef]);
      if (lost.rowCount) await this.fenceExecution(tx, proof.executionRef);
    });
  }
  async fence(context: TrustedContext, id: string, subject: string, revision: number): Promise<OperationStatus> {
    identifier(id); identifier(subject); authorityRevision(revision);
    return this.transaction(context, async tx => {
      const intent = { kind: 'fence', subject, revision };
      const old = await this.existing(tx, id, intent);
      if (old) return old;
      const f = await tx.db.query('SELECT revision FROM policy_fences WHERE consumer=$1 AND subject=$2', [tx.consumer, subject]);
      if (f.rows[0] && Number(f.rows[0].revision) > revision) throw new KernelError('conflict');
      await this.insertOperation(tx, id, intent);
      await tx.db.query(`INSERT INTO policy_fences(consumer,subject,revision) VALUES ($1,$2,$3)
        ON CONFLICT (consumer,subject) DO UPDATE SET revision=excluded.revision,fence=gen_random_uuid()`, [tx.consumer, subject, revision]);
      const es = await tx.db.query(`UPDATE executions SET state='fenced' WHERE consumer=$1 AND policy_subject=$2
        AND policy_revision<=$3 AND state='open' RETURNING ref`, [tx.consumer, subject, revision]);
      for (const e of es.rows) await this.cleanup(tx, undefined, e.ref);
      await tx.db.query("UPDATE operations SET state='applied' WHERE consumer=$1 AND id=$2", [tx.consumer, id]);
      return this.op(tx, id);
    });
  }
  async close(context: TrustedContext, id: string, ref: string): Promise<OperationStatus> {
    identifier(id); uuid(ref);
    return this.transaction(context, async tx => {
      const intent = { kind: 'close', execution: ref };
      const old = await this.existing(tx, id, intent);
      if (old) return old;
      const e = await this.one(tx, 'SELECT * FROM executions WHERE consumer=$1 AND ref=$2', [tx.consumer, ref]);
      await this.insertOperation(tx, id, intent, e.account_ref, ref);
      await tx.db.query("UPDATE executions SET state='closed' WHERE consumer=$1 AND ref=$2 AND state='open'", [tx.consumer, ref]);
      await this.cleanup(tx, undefined, ref);
      await tx.db.query("UPDATE operations SET state='applied' WHERE consumer=$1 AND id=$2", [tx.consumer, id]);
      return this.op(tx, id);
    });
  }
  async heartbeat(context: TrustedContext, worker: string): Promise<void> {
    uuid(worker);
    return this.transaction(context, async tx => {
      // Only expired enrollment with no accepted work may release a prepaid
      // slot. Excluding this UUID preserves the expired-lease renewal denial.
      await tx.db.query(`DELETE FROM ag_kernel.workers w WHERE w.consumer=$1 AND w.worker<>$2
        AND w.lease_until<=clock_timestamp()
        AND NOT EXISTS (SELECT 1 FROM ag_kernel.candidates c WHERE c.consumer=w.consumer AND c.worker=w.worker)
        AND NOT EXISTS (SELECT 1 FROM ag_kernel.requests r WHERE r.consumer=w.consumer AND r.worker=w.worker)
        AND NOT EXISTS (SELECT 1 FROM ag_kernel.cleanup j WHERE j.consumer=w.consumer AND j.worker=w.worker)
        AND NOT EXISTS (SELECT 1 FROM ag_management.candidate_journal j WHERE j.consumer=w.consumer AND j.worker=w.worker)`,
      [tx.consumer, worker]);
      const r = await tx.db.query(`INSERT INTO workers(consumer,worker,lease_until)
        VALUES ($1,$2,clock_timestamp()+$3*interval '1 millisecond') ON CONFLICT (consumer,worker)
        DO UPDATE SET lease_until=excluded.lease_until WHERE workers.lease_until>clock_timestamp() RETURNING worker`,
      [tx.consumer, worker, this.bounds.workerLeaseMs]);
      if (!r.rowCount) throw new KernelError('denied');
    });
  }
  private async reconcileRequests(tx: Tx, ref?: string, limit = this.bounds.maintenanceBatch, account?: string): Promise<boolean> {
    const lost = await tx.db.query(`SELECT r.* FROM requests r LEFT JOIN workers w
      ON w.consumer=r.consumer AND w.worker=r.worker WHERE r.consumer=$1
      AND (($4::uuid IS NULL AND ($3::uuid IS NULL OR r.execution_ref=$3)) OR EXISTS
        (SELECT 1 FROM executions e WHERE e.consumer=r.consumer AND e.ref=r.execution_ref AND e.account_ref=$4))
      AND r.effect IN ('dispatch_started','response_started') AND (w.worker IS NULL OR w.lease_until<=clock_timestamp())
      ORDER BY r.transport_occupied DESC,(r.execution_ref=$3) DESC,r.execution_ref,r.id LIMIT $2`,
    [tx.consumer, limit, ref ?? null, account ?? null]);
    for (const r of lost.rows) {
      await tx.db.query("UPDATE requests SET effect='effect_unknown',code='owner_lost' WHERE consumer=$1 AND execution_ref=$2 AND id=$3",
        [tx.consumer, r.execution_ref, r.id]);
      await this.fenceExecution(tx, r.execution_ref);
    }
    return ref ? lost.rows.some(r => r.execution_ref === ref) : lost.rows.length > 0;
  }
  async reconcile(context: TrustedContext): Promise<void> {
    return this.transaction(context, async tx => {
      await this.reconcileRequests(tx);
      const cs = await tx.db.query(`SELECT c.* FROM candidates c LEFT JOIN workers w
        ON w.consumer=c.consumer AND w.worker=c.worker WHERE c.consumer=$1 AND c.state='creating'
        AND (w.worker IS NULL OR w.lease_until<=clock_timestamp()) LIMIT $2`, [tx.consumer, this.bounds.maintenanceBatch]);
      for (const c of cs.rows) await this.quarantineCandidate(tx, c);
      const es = await tx.db.query(`SELECT ref FROM executions WHERE consumer=$1 AND state='open'
        AND deadline<=clock_timestamp() ORDER BY deadline LIMIT $2`, [tx.consumer, this.bounds.maintenanceBatch]);
      for (const e of es.rows) {
        await tx.db.query("UPDATE executions SET state='closed' WHERE consumer=$1 AND ref=$2", [tx.consumer, e.ref]);
        await this.cleanup(tx, undefined, e.ref);
      }
      await compactSafePayloads(tx.db, tx.consumer, this.bounds.maintenanceBatch);
    });
  }
  async restore(context: TrustedContext, expectedIssuer: string, freshIssuer: string): Promise<void> {
    uuid(expectedIssuer); uuid(freshIssuer);
    if (expectedIssuer === freshIssuer) throw new KernelError('invalid');
    return this.transaction(context, async tx => {
      if (tx.issuer !== expectedIssuer) throw new KernelError('conflict');
      const seen = await tx.db.query('SELECT 1 FROM issuer_epochs WHERE consumer=$1 AND issuer=$2', [tx.consumer, freshIssuer]);
      if (seen.rowCount) throw new KernelError('conflict');
      await tx.db.query('INSERT INTO issuer_epochs(consumer,issuer) VALUES ($1,$2)', [tx.consumer, freshIssuer]);
      await tx.db.query('UPDATE consumers SET issuer=$2 WHERE consumer=$1', [tx.consumer, freshIssuer]);
      await tx.db.query("UPDATE requests SET effect='effect_unknown',code='restore' WHERE consumer=$1 AND effect IN ('dispatch_started','response_started')", [tx.consumer]);
      const es = await tx.db.query("UPDATE executions SET state='fenced' WHERE consumer=$1 RETURNING ref", [tx.consumer]);
      for (const e of es.rows) await this.cleanup(tx, undefined, e.ref);
      await tx.db.query("UPDATE accounts SET state='quarantined',epoch=epoch+1 WHERE consumer=$1 AND state IN ('active','staging')", [tx.consumer]);
      const cs = await tx.db.query("UPDATE candidates SET state='quarantined' WHERE consumer=$1 AND state IN ('ready','creating','staged','quarantined') RETURNING generation", [tx.consumer]);
      for (const c of cs.rows) await this.cleanup(tx, c.generation);
      await tx.db.query("UPDATE operations SET state='unknown',code='restore' WHERE consumer=$1 AND state='pending'", [tx.consumer]);
    });
  }
  async claimCleanup(context: TrustedContext, worker: string): Promise<CleanupClaim | undefined> {
    uuid(worker);
    return this.transaction(context, async tx => {
      await this.worker(tx, worker);
      const r = await tx.db.query(`SELECT j.*,c.native_identity,c.profile FROM cleanup j LEFT JOIN candidates c
        ON c.consumer=j.consumer AND c.generation=j.generation WHERE j.consumer=$1
        AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.consumer=j.consumer
          AND a.active_generation=j.generation AND a.state='active')
        AND (j.state='pending' OR (j.state='claimed' AND j.lease_until<=clock_timestamp()))
        ORDER BY j.lease_until NULLS FIRST,j.ref LIMIT 1 FOR UPDATE OF j SKIP LOCKED`, [tx.consumer]);
      const j = r.rows[0];
      if (!j) return undefined;
      const token = randomUUID();
      await tx.db.query(`UPDATE cleanup SET state='claimed',worker=$3,token=$4,
        lease_until=clock_timestamp()+$5*interval '1 millisecond' WHERE consumer=$1 AND ref=$2`,
      [tx.consumer, j.ref, worker, token, this.bounds.cleanupLeaseMs]);
      const scope: CleanupClaim['scope'] = j.generation
        ? { kind: 'generation', generation: j.generation, profile: j.profile,
            ...(j.native_identity ? { descriptor: descriptor(j) } : {}) }
        : { kind: 'execution', executionRef: j.execution_ref, transports: await this.transports(tx, j.execution_ref) };
      return { cleanupRef: j.ref, token, scope };
    });
  }
  private async transports(tx: Tx, ref: string): Promise<readonly TransportClosure[]> {
    const r = await tx.db.query(`SELECT execution_ref,id,worker,closure_token,native_origin_ref,engine_incarnation,request_nonce,descriptor_generation FROM requests
      WHERE consumer=$1 AND execution_ref=$2 AND transport_occupied ORDER BY (native_origin_ref IS NULL),(closure_token IS NULL),id LIMIT $3`,
    [tx.consumer, ref, Math.min(this.bounds.maintenanceBatch, 128)]);
    return r.rows.map(transportClosure);
  }
  async cleanupTransports(context: TrustedContext, ref: string, worker: string, token: string): Promise<readonly TransportClosure[]> {
    uuid(ref); uuid(worker); uuid(token);
    return this.transaction(context, async tx => {
      const j = (await tx.db.query(`SELECT execution_ref FROM cleanup WHERE consumer=$1 AND ref=$2
        AND worker=$3 AND token=$4 AND state='claimed' AND lease_until>clock_timestamp()
        AND execution_ref IS NOT NULL`, [tx.consumer, ref, worker, token])).rows[0];
      if (!j) throw new KernelError('denied');
      // Read another bounded page after acknowledging the previous page. No
      // token rotation, guessed request range or volatile dispatch permit needed.
      return this.transports(tx, j.execution_ref);
    });
  }
  async currentCleanupLease(context: TrustedContext, ref: string, worker: string, token: string): Promise<string> {
    uuid(ref); uuid(worker); uuid(token);
    return this.transaction(context, async tx => {
      const j = (await tx.db.query(`SELECT to_char(lease_until AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires FROM cleanup WHERE consumer=$1 AND ref=$2
        AND worker=$3 AND token=$4 AND state='claimed' AND lease_until>clock_timestamp()
        AND execution_ref IS NOT NULL`, [tx.consumer, ref, worker, token])).rows[0];
      if (!j) throw new KernelError('denied');
      return j.expires as string;
    });
  }
  async settleCleanup(context: TrustedContext, ref: string, worker: string, token: string, succeeded: boolean): Promise<void> {
    uuid(ref); uuid(worker); uuid(token);
    if (typeof succeeded !== 'boolean') throw new KernelError('invalid');
    return this.transaction(context, async tx => {
      const j = await this.one(tx, 'SELECT * FROM cleanup WHERE consumer=$1 AND ref=$2', [tx.consumer, ref]);
      if (j.worker !== worker || j.token !== token) throw new KernelError('denied');
      if (succeeded && j.execution_ref) {
        const occupied = await tx.db.query(`SELECT 1 FROM requests WHERE consumer=$1
          AND execution_ref=$2 AND transport_occupied LIMIT 1`, [tx.consumer, j.execution_ref]);
        if (occupied.rowCount) throw new KernelError('conflict');
      }
      if (j.state === 'done' && succeeded) return;
      const updated = await tx.db.query(`UPDATE cleanup SET state=$5 WHERE consumer=$1 AND ref=$2
        AND worker=$3 AND token=$4 AND state='claimed' AND lease_until>clock_timestamp() RETURNING generation`,
      [tx.consumer, ref, worker, token, succeeded ? 'done' : 'pending']);
      if (!updated.rowCount) throw new KernelError('denied');
      if (succeeded && j.generation) {
        // A stale cleanup task must never retire a currently active route.
        const active = await tx.db.query("SELECT 1 FROM accounts WHERE consumer=$1 AND active_generation=$2 AND state='active'", [tx.consumer, j.generation]);
        if (active.rowCount) throw new KernelError('conflict');
        await tx.db.query("UPDATE candidates SET state='retired' WHERE consumer=$1 AND generation=$2", [tx.consumer, j.generation]);
      }
    });
  }
}
