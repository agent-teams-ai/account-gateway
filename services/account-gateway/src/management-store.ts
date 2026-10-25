import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { sharedCheckout } from "./service-admission.ts";
import type { Checkout } from "./service-admission.ts";
import { KernelError, identifier, uuid } from "./domain.ts";
import type { TrustedContext } from "./domain.ts";
import { captureContext, exactCandidate, physicalCandidate } from "./management.ts";
import { oauthProfileDefinition } from "./oauth-profiles.ts";
import type {
  AcceptedIntent,
  CandidateJournal,
  CandidateMapping,
  CandidateScope,
  IntentCustody,
  ManagedProfile,
  ManagementStore,
  OAuthSelectors,
  OAuthCleanupAuthority,
  OAuthCleanupAction,
  OAuthCleanupScope,
} from "./management.ts";

export interface IntentEnvelope {
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly tag: Buffer;
}
function scopeCopy(s: CandidateScope): CandidateScope {
  const copy = Object.freeze({
    consumerId: s.consumerId,
    operationId: s.operationId,
    accountRef: s.accountRef,
    ownerRef: s.ownerRef,
    purpose: s.purpose,
  });
  identifier(copy.consumerId);
  identifier(copy.operationId);
  uuid(copy.accountRef);
  identifier(copy.ownerRef);
  if (!["create", "reconnect"].includes(copy.purpose)) throw new KernelError("invalid");
  return copy;
}
function aad(s: CandidateScope): Buffer {
  return Buffer.from(
    JSON.stringify([
      "account-gateway/transient/v1",
      s.consumerId,
      s.operationId,
      s.accountRef,
      s.ownerRef,
      s.purpose,
    ]),
    "utf8",
  );
}
// Trusted composition supplies two distinct keys from outside DB/backups. No env lookup.
export class IntentSecrets implements IntentCustody {
  readonly #aead: Buffer;
  readonly #hmac: Buffer;
  constructor(aeadKey: Uint8Array, hmacKey: Uint8Array) {
    if (
      aeadKey.byteLength !== 32 ||
      hmacKey.byteLength !== 32 ||
      Buffer.from(aeadKey).equals(Buffer.from(hmacKey))
    )
      throw new KernelError("invalid");
    this.#aead = Buffer.from(aeadKey);
    this.#hmac = Buffer.from(hmacKey);
  }
  digest(accepted: AcceptedIntent): string {
    const i = accepted.intent;
    // Fixed primitive tuple binds every accepted field, including exact submitted key.
    return createHmac("sha256", this.#hmac)
      .update(
        JSON.stringify([
          "account-gateway/intent/v1",
          accepted.context.consumerId,
          i.operationId,
          i.kind,
          i.accountRef ?? null,
          i.expectedRevision ?? null,
          i.ownerRef ?? null,
          i.profile ?? null,
          i.displayName ?? null,
          accepted.apiKey ?? null,
          ...(i.oauthMethod === undefined ? [] : [i.oauthMethod]),
        ]),
      )
      .digest("hex");
  }
  seal(scope: CandidateScope, apiKey: string): IntentEnvelope {
    const s = scopeCopy(scope);
    if (typeof apiKey !== "string" || !apiKey.isWellFormed()) throw new KernelError("invalid");
    const plaintext = Buffer.from(apiKey, "utf8");
    try {
      if (plaintext.length < 1 || plaintext.length > 4096) throw new KernelError("invalid");
      const nonce = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", this.#aead, nonce);
      cipher.setAAD(aad(s));
      return {
        nonce,
        ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final()]),
        tag: cipher.getAuthTag(),
      };
    } finally {
      plaintext.fill(0);
    }
  }
  open(scope: CandidateScope, envelope: IntentEnvelope): string {
    const s = scopeCopy(scope);
    let plaintext: Buffer | undefined;
    try {
      if (
        envelope.nonce.length !== 12 ||
        envelope.tag.length !== 16 ||
        envelope.ciphertext.length < 1 ||
        envelope.ciphertext.length > 4096
      )
        throw new KernelError("unavailable");
      const decipher = createDecipheriv("aes-256-gcm", this.#aead, envelope.nonce);
      decipher.setAAD(aad(s));
      decipher.setAuthTag(envelope.tag);
      plaintext = Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
      return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    } catch {
      throw new KernelError("unavailable");
    } finally {
      plaintext?.fill(0);
    } // Does not promise immutable JS string zeroization.
  }
}
interface JournalRow {
  consumer: string;
  operation_id: string;
  account_ref: string;
  owner_ref: string;
  purpose: "create" | "reconnect";
  generation: string;
  worker: string;
  profile: string;
  base_url: string;
  model: string;
  qualification_ref: string;
}
function journalRow(r: JournalRow): CandidateJournal {
  return Object.freeze({
    consumerId: r.consumer,
    operationId: r.operation_id,
    accountRef: r.account_ref,
    ownerRef: r.owner_ref,
    purpose: r.purpose,
    generation: r.generation,
    worker: r.worker,
    profile: Object.freeze({
      profile: r.profile,
      baseURL: r.base_url,
      model: r.model,
      qualificationRef: r.qualification_ref,
    }),
  });
}
const journalValues = (j: CandidateJournal): readonly unknown[] => [
  j.consumerId,
  j.operationId,
  j.accountRef,
  j.ownerRef,
  j.purpose,
  j.generation,
  j.worker,
  j.profile.profile,
  j.profile.baseURL,
  j.profile.model,
  j.profile.qualificationRef,
];
function sameJournal(a: CandidateJournal, b: CandidateJournal): boolean {
  return JSON.stringify(journalValues(a)) === JSON.stringify(journalValues(b));
}
type MappingRow = JournalRow & {
  native_physical_identity: string;
  native_id: string;
  native_created_at: string;
};
function mappingRow(r: MappingRow): CandidateMapping {
  const j = journalRow(r);
  const descriptor = physicalCandidate({
    generation: j.generation,
    nativePhysicalIdentity: r.native_physical_identity,
    nativeId: Number(r.native_id),
    createdAt: r.native_created_at,
    profile: j.profile.profile,
    baseURL: j.profile.baseURL,
    model: j.profile.model,
  });
  if (!exactCandidate(j, descriptor)) throw new KernelError("conflict");
  return Object.freeze({ ...j, descriptor });
}
// Both selection and the protected callback use the same active physical scope.
// The journal's worker is historical; the CURRENT service lease gates maintenance.
const activeOAuthMapping = `SELECT j.*,m.native_physical_identity,m.native_id,m.native_created_at
  FROM ag_kernel.accounts a JOIN ag_kernel.candidates c
    ON c.consumer=a.consumer AND c.account_ref=a.ref AND c.generation=a.active_generation
  JOIN ag_management.candidate_journal j
    ON j.consumer=c.consumer AND j.generation=c.generation AND j.account_ref=a.ref
      AND j.operation_id=c.operation_id AND j.owner_ref=a.owner_ref AND j.profile=c.profile
  JOIN ag_management.physical_mappings m ON m.consumer=j.consumer AND m.generation=j.generation
  JOIN ag_kernel.operations o ON o.consumer=j.consumer AND o.id=j.operation_id AND o.account_ref=a.ref
  WHERE a.consumer=$1 AND a.state='active' AND a.profile=$3 AND c.state='ready'
    AND c.native_identity=j.generation AND m.native_physical_identity=j.generation
    AND j.profile=$3 AND j.base_url=$4 AND j.model=$5 AND j.qualification_ref=$6
    AND j.purpose IN ('create','reconnect') AND o.state='applied' AND o.intent->>'kind'=j.purpose
    AND EXISTS (SELECT 1 FROM ag_kernel.workers w WHERE w.consumer=a.consumer AND w.worker=$2
      AND w.lease_until>clock_timestamp())`;
// Staging recovery is bound to the ORIGINAL creator, not a replacement service.
// No physical mapping grants authority; native additionally checks completed
// enrollment/MAC before the existing F2 fence can enter a refresh.
const pendingOAuthJournal = `SELECT j.* FROM ag_kernel.accounts a
  JOIN ag_kernel.candidates c ON c.consumer=a.consumer AND c.account_ref=a.ref
  JOIN ag_management.candidate_journal j ON j.consumer=c.consumer
    AND j.generation=c.generation AND j.account_ref=a.ref AND j.operation_id=c.operation_id
    AND j.owner_ref=a.owner_ref AND j.profile=c.profile AND j.worker=c.worker
  JOIN ag_kernel.operations o ON o.consumer=j.consumer AND o.id=j.operation_id AND o.account_ref=a.ref
  WHERE a.consumer=$1 AND a.profile=$3 AND c.state='creating' AND c.native_identity IS NULL
    AND c.expected_epoch=a.epoch AND c.worker=$2 AND o.state='pending'
    AND o.intent->>'kind'=j.purpose AND (
      j.purpose='create' AND a.state='staging' AND a.active_generation IS NULL
        AND c.old_generation IS NULL AND c.expected_revision<=a.revision
        AND o.intent->>'owner'=j.owner_ref AND o.intent->>'profile'=j.profile
      -- Disabled remains nonexecutable until fresh proof promotion. Kernel
      -- admitted this exact new reconnect only after prior erasure/closure;
      -- a later disable/rename still loses the revision/epoch checks above.
      OR j.purpose='reconnect' AND a.state IN ('active','quarantined','disabled')
        AND c.expected_revision=a.revision AND c.old_generation IS NOT DISTINCT FROM a.active_generation
        AND o.intent->>'target'=a.ref::text AND (o.intent->>'expectedRevision')::integer=c.expected_revision)
    AND j.profile=$3 AND j.base_url=$4 AND j.model=$5 AND j.qualification_ref=$6
    AND EXISTS (SELECT 1 FROM ag_kernel.workers w WHERE w.consumer=a.consumer
      AND w.worker=c.worker AND w.lease_until>clock_timestamp())
    AND NOT EXISTS (SELECT 1 FROM ag_kernel.cleanup l WHERE l.consumer=c.consumer AND l.generation=c.generation)`;
function refreshProfile(source: ManagedProfile): ManagedProfile {
  const p = Object.freeze({
    profile: source.profile,
    baseURL: source.baseURL,
    model: source.model,
    qualificationRef: source.qualificationRef,
  });
  const definition = oauthProfileDefinition(p.profile);
  if (!definition || p.baseURL !== definition.baseURL || p.model !== definition.model)
    throw new KernelError("invalid");
  identifier(p.qualificationRef);
  return p;
}

export class PostgresManagementStore implements ManagementStore {
  private readonly checkout: Checkout;
  private readonly secrets: IntentSecrets;
  private readonly ttlMs: number;
  private readonly maxIntents: number;
  private readonly batch: number;
  constructor(
    pool: Pool,
    secrets: IntentSecrets,
    options: { ttlMs?: number; maxIntents?: number; batch?: number } = {},
  ) {
    const ttlMs = options.ttlMs ?? 60_000,
      maxIntents = options.maxIntents ?? 256,
      batch = options.batch ?? 100;
    if (
      !Number.isInteger(ttlMs) ||
      ttlMs < 1 ||
      ttlMs > 300_000 ||
      !Number.isInteger(maxIntents) ||
      maxIntents < 1 ||
      maxIntents > 4096 ||
      !Number.isInteger(batch) ||
      batch < 1 ||
      batch > 1000
    )
      throw new KernelError("invalid");
    this.checkout = sharedCheckout(pool);
    this.secrets = secrets;
    this.ttlMs = ttlMs;
    this.maxIntents = maxIntents;
    this.batch = batch;
  }
  private async tx<T>(consumer: string, action: (db: PoolClient) => Promise<T>): Promise<T> {
    identifier(consumer);
    let db: PoolClient | undefined;
    try {
      db = await this.checkout();
      await db.query("BEGIN");
      // Reuse the kernel consumer serialization lock; no management permit/authority.
      const existing = await db.query(
        "SELECT 1 FROM ag_kernel.consumers WHERE consumer=$1 FOR UPDATE",
        [consumer],
      );
      if (!existing.rowCount) throw new KernelError("unknown");
      const result = await action(db);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      if (db) await db.query("ROLLBACK").catch(() => undefined);
      if (error instanceof KernelError) throw error;
      // SQL errors can contain plaintext query parameters. Never reflect them.
      throw new KernelError("unavailable");
    } finally {
      db?.release();
    }
  }
  async stage(scope: CandidateScope, apiKey: string): Promise<boolean> {
    const s = scopeCopy(scope),
      envelope = this.secrets.seal(s, apiKey);
    return this.tx(s.consumerId, async (db) => {
      const old = (
        await db.query(
          `SELECT account_ref,owner_ref,purpose,ciphertext IS NOT NULL AND
        expires_at>clock_timestamp() AS live FROM ag_management.transient_intents WHERE consumer=$1 AND operation_id=$2`,
          [s.consumerId, s.operationId],
        )
      ).rows[0];
      if (old) {
        if (
          old.account_ref !== s.accountRef ||
          old.owner_ref !== s.ownerRef ||
          old.purpose !== s.purpose
        )
          throw new KernelError("conflict");
        return old.live as boolean;
      }
      const count = (
        await db.query(
          "SELECT count(*)::integer AS n FROM ag_management.transient_intents WHERE consumer=$1",
          [s.consumerId],
        )
      ).rows[0].n;
      if (count >= this.maxIntents) throw new KernelError("unavailable");
      const valid = await db.query(
        `SELECT 1 FROM ag_kernel.operations o JOIN ag_kernel.accounts a
        ON a.consumer=o.consumer AND a.ref=o.account_ref JOIN ag_kernel.candidates c
        ON c.consumer=o.consumer AND c.operation_id=o.id WHERE o.consumer=$1 AND o.id=$2
        AND a.ref=$3 AND a.owner_ref=$4 AND o.intent->>'kind'=$5 AND o.state='pending' AND c.state='staged'`,
        [s.consumerId, s.operationId, s.accountRef, s.ownerRef, s.purpose],
      );
      if (!valid.rowCount) return false;
      await db.query(
        `INSERT INTO ag_management.transient_intents
        (consumer,operation_id,account_ref,owner_ref,purpose,nonce,ciphertext,tag,created_at,expires_at)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,t,t+$9*interval '1 millisecond' FROM (SELECT clock_timestamp() AS t) stamp`,
        [
          s.consumerId,
          s.operationId,
          s.accountRef,
          s.ownerRef,
          s.purpose,
          envelope.nonce,
          envelope.ciphertext,
          envelope.tag,
          this.ttlMs,
        ],
      );
      return true;
    });
  }
  async journal(
    scope: CandidateScope,
    generation: string,
    worker: string,
    source: ManagedProfile,
  ): Promise<CandidateJournal> {
    const s = scopeCopy(scope);
    const profile = Object.freeze({
      profile: source.profile,
      baseURL: source.baseURL,
      model: source.model,
      qualificationRef: source.qualificationRef,
    });
    uuid(generation);
    uuid(worker);
    identifier(profile.profile, 64);
    identifier(profile.qualificationRef);
    const journal = Object.freeze({ ...s, generation, worker, profile });
    return this.tx(s.consumerId, async (db) => {
      const owned = await db.query(
        `SELECT 1 FROM ag_kernel.candidates c JOIN ag_kernel.accounts a
        ON a.consumer=c.consumer AND a.ref=c.account_ref WHERE c.consumer=$1 AND c.operation_id=$2
        AND c.account_ref=$3 AND a.owner_ref=$4 AND c.generation=$5 AND c.worker=$6 AND c.profile=$7 AND c.state='creating'`,
        [
          s.consumerId,
          s.operationId,
          s.accountRef,
          s.ownerRef,
          generation,
          worker,
          profile.profile,
        ],
      );
      if (!owned.rowCount) throw new KernelError("denied");
      await db.query(
        `INSERT INTO ag_management.candidate_journal
        (consumer,operation_id,account_ref,owner_ref,purpose,generation,worker,profile,base_url,model,qualification_ref)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
        [...journalValues(journal)],
      );
      const stored = (
        await db.query<JournalRow>(
          "SELECT * FROM ag_management.candidate_journal WHERE consumer=$1 AND operation_id=$2",
          [s.consumerId, s.operationId],
        )
      ).rows[0];
      if (!stored || !sameJournal(journal, journalRow(stored))) throw new KernelError("conflict");
      return journalRow(stored);
    });
  }
  async readJournal(
    context: TrustedContext,
    operationId: string,
  ): Promise<CandidateJournal | undefined> {
    const ctx = captureContext(context);
    identifier(operationId);
    return this.tx(ctx.consumerId, async (db) => {
      const r = (
        await db.query<JournalRow>(
          "SELECT * FROM ag_management.candidate_journal WHERE consumer=$1 AND operation_id=$2",
          [ctx.consumerId, operationId],
        )
      ).rows[0];
      return r ? journalRow(r) : undefined;
    });
  }
  async credential(scope: CandidateScope): Promise<string | undefined> {
    const s = scopeCopy(scope);
    return this.tx(s.consumerId, async (db) => {
      const r = (
        await db.query(
          `SELECT nonce,ciphertext,tag FROM ag_management.transient_intents
        WHERE consumer=$1 AND operation_id=$2 AND account_ref=$3 AND owner_ref=$4 AND purpose=$5
        AND expires_at>clock_timestamp() AND ciphertext IS NOT NULL`,
          [s.consumerId, s.operationId, s.accountRef, s.ownerRef, s.purpose],
        )
      ).rows[0];
      return r ? this.secrets.open(s, r as IntentEnvelope) : undefined;
    });
  }
  async eraseIntent(scope: CandidateScope): Promise<void> {
    const s = scopeCopy(scope);
    return this.tx(s.consumerId, async (db) => {
      await db.query(
        `UPDATE ag_management.transient_intents SET nonce=NULL,ciphertext=NULL,tag=NULL
        WHERE consumer=$1 AND operation_id=$2 AND account_ref=$3 AND owner_ref=$4 AND purpose=$5`,
        [s.consumerId, s.operationId, s.accountRef, s.ownerRef, s.purpose],
      );
    });
  }
  async saveMapping(input: CandidateMapping): Promise<void> {
    const s = scopeCopy(input),
      d = physicalCandidate(input.descriptor);
    const j: CandidateJournal = {
      ...s,
      generation: input.generation,
      worker: input.worker,
      profile: Object.freeze({
        profile: input.profile.profile,
        baseURL: input.profile.baseURL,
        model: input.profile.model,
        qualificationRef: input.profile.qualificationRef,
      }),
    };
    if (!exactCandidate(j, d)) throw new KernelError("conflict");
    return this.tx(s.consumerId, async (db) => {
      const stored = (
        await db.query<JournalRow>(
          "SELECT * FROM ag_management.candidate_journal WHERE consumer=$1 AND generation=$2",
          [s.consumerId, j.generation],
        )
      ).rows[0];
      if (!stored || !sameJournal(j, journalRow(stored))) throw new KernelError("conflict");
      await db.query(
        `INSERT INTO ag_management.physical_mappings
        (consumer,generation,native_physical_identity,native_id,native_created_at) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT DO NOTHING`,
        [s.consumerId, j.generation, d.nativePhysicalIdentity, d.nativeId, d.createdAt],
      );
      const row = (
        await db.query(
          "SELECT * FROM ag_management.physical_mappings WHERE consumer=$1 AND generation=$2",
          [s.consumerId, j.generation],
        )
      ).rows[0];
      if (
        !row ||
        row.native_physical_identity !== d.nativePhysicalIdentity ||
        Number(row.native_id) !== d.nativeId ||
        row.native_created_at !== d.createdAt
      )
        throw new KernelError("conflict");
    });
  }
  async mapping(
    context: TrustedContext,
    generation: string,
  ): Promise<CandidateMapping | undefined> {
    const ctx = captureContext(context);
    uuid(generation);
    return this.tx(ctx.consumerId, async (db) => {
      const r = (
        await db.query<
          JournalRow & {
            native_physical_identity: string;
            native_id: string;
            native_created_at: string;
          }
        >(
          `SELECT j.*,m.native_physical_identity,m.native_id,m.native_created_at
        FROM ag_management.candidate_journal j JOIN ag_management.physical_mappings m
        ON m.consumer=j.consumer AND m.generation=j.generation WHERE j.consumer=$1 AND j.generation=$2`,
          [ctx.consumerId, generation],
        )
      ).rows[0];
      if (!r) return undefined;
      const j = journalRow(r);
      const descriptor = physicalCandidate({
        generation: j.generation,
        nativePhysicalIdentity: r.native_physical_identity,
        nativeId: Number(r.native_id),
        createdAt: r.native_created_at,
        profile: j.profile.profile,
        baseURL: j.profile.baseURL,
        model: j.profile.model,
      });
      if (!exactCandidate(j, descriptor)) throw new KernelError("conflict");
      return Object.freeze({ ...j, descriptor });
    });
  }
  async nextOAuthRefresh(
    context: TrustedContext,
    worker: string,
    source: ManagedProfile,
    after?: string,
  ): Promise<CandidateMapping | undefined> {
    const ctx = captureContext(context),
      p = refreshProfile(source),
      cursor = after;
    uuid(worker);
    if (cursor !== undefined) uuid(cursor);
    return this.tx(ctx.consumerId, async (db) => {
      const values = [ctx.consumerId, worker, p.profile, p.baseURL, p.model, p.qualificationRef];
      const select = async (after: string | undefined): Promise<MappingRow | undefined> =>
        (
          await db.query<MappingRow>(
            activeOAuthMapping +
              " AND ($7::uuid IS NULL OR j.generation>$7::uuid) ORDER BY j.generation LIMIT 1",
            [...values, after ?? null],
          )
        ).rows[0];
      // At most two finite LIMIT 1 reads; no OFFSET or materialized account list.
      const row =
        (await select(cursor)) ?? (cursor === undefined ? undefined : await select(undefined));
      return row ? mappingRow(row) : undefined;
    }); // tx COMMIT and release precede native HTTP, never span callback awaits.
  }
  async activeOAuthRefresh(
    context: TrustedContext,
    worker: string,
    input: OAuthSelectors,
    source: ManagedProfile,
  ): Promise<CandidateMapping | undefined> {
    const ctx = captureContext(context),
      p = refreshProfile(source);
    const s = Object.freeze({
      consumerId: input.consumerId,
      operationId: input.operationId,
      accountRef: input.accountRef,
      generation: input.generation,
    });
    uuid(worker);
    identifier(s.operationId);
    uuid(s.accountRef);
    uuid(s.generation);
    if (s.consumerId !== ctx.consumerId) throw new KernelError("denied");
    return this.tx(ctx.consumerId, async (db) => {
      const row = (
        await db.query<MappingRow>(
          activeOAuthMapping +
            " AND j.operation_id=$7 AND j.account_ref=$8 AND j.generation=$9 LIMIT 1",
          [
            ctx.consumerId,
            worker,
            p.profile,
            p.baseURL,
            p.model,
            p.qualificationRef,
            s.operationId,
            s.accountRef,
            s.generation,
          ],
        )
      ).rows[0];
      return row ? mappingRow(row) : undefined;
    });
  }
  async pendingOAuthRefresh(
    context: TrustedContext,
    worker: string,
    input: OAuthSelectors,
    source: ManagedProfile,
  ): Promise<CandidateJournal | undefined> {
    const ctx = captureContext(context),
      p = refreshProfile(source);
    const s = Object.freeze({
      consumerId: input.consumerId,
      operationId: input.operationId,
      accountRef: input.accountRef,
      generation: input.generation,
    });
    uuid(worker);
    identifier(s.operationId);
    uuid(s.accountRef);
    uuid(s.generation);
    if (s.consumerId !== ctx.consumerId) throw new KernelError("denied");
    return this.tx(ctx.consumerId, async (db) => {
      const row = (
        await db.query<JournalRow>(
          pendingOAuthJournal +
            " AND j.operation_id=$7 AND j.account_ref=$8 AND j.generation=$9 LIMIT 1",
          [
            ctx.consumerId,
            worker,
            p.profile,
            p.baseURL,
            p.model,
            p.qualificationRef,
            s.operationId,
            s.accountRef,
            s.generation,
          ],
        )
      ).rows[0];
      return row ? journalRow(row) : undefined;
    }); // Release consumer lock before native refresh and its authority callback.
  }
  async cleanupAllowed(
    context: TrustedContext,
    cleanupRef: string,
    worker: string,
    token: string,
    generation: string,
    identity: string,
    profile: string,
  ): Promise<boolean> {
    const ctx = captureContext(context);
    uuid(cleanupRef);
    uuid(worker);
    uuid(token);
    uuid(generation);
    uuid(identity);
    identifier(profile, 64);
    return this.tx(ctx.consumerId, async (db) => {
      const r = await db.query(
        `SELECT 1 FROM ag_kernel.cleanup j JOIN ag_kernel.candidates c
        ON c.consumer=j.consumer AND c.generation=j.generation WHERE j.consumer=$1 AND j.ref=$2
        AND j.worker=$3 AND j.token=$4 AND j.generation=$5 AND c.native_identity=$6 AND c.profile=$7
        AND j.state='claimed' AND j.lease_until>clock_timestamp() AND NOT EXISTS
          (SELECT 1 FROM ag_kernel.accounts a WHERE a.consumer=j.consumer
            AND a.active_generation=j.generation AND a.state IN ('active','suspended'))
        AND NOT EXISTS (SELECT 1 FROM ag_kernel.requests r
          JOIN ag_kernel.executions e ON e.consumer=r.consumer AND e.ref=r.execution_ref
          WHERE r.consumer=j.consumer AND e.generation=j.generation AND r.transport_occupied)`,
        [ctx.consumerId, cleanupRef, worker, token, generation, identity, profile],
      );
      return r.rowCount === 1;
    });
  }
  async retirement(context: TrustedContext, accountRef: string, operationId: string) {
    const ctx = captureContext(context);
    uuid(accountRef);
    identifier(operationId);
    return this.tx(ctx.consumerId, async (db) => {
      const operation = (
        await db.query<{
          account_ref: string | null;
          state: string;
          revision: number | null;
          epoch: number | null;
          intent_kind: string | null;
          intent_target: string | null;
        }>(
          `SELECT account_ref,state,revision,epoch,intent->>'kind' AS intent_kind,
          intent->>'target' AS intent_target FROM ag_kernel.operations WHERE consumer=$1 AND id=$2`,
          [ctx.consumerId, operationId],
        )
      ).rows[0];
      // Missing is unknown through AccountManagement, never positive absence.
      if (!operation) return undefined;
      const account = (
        await db.query<{
          ref: string;
          owner_ref: string;
          profile: string;
          display_name: string;
          state: "staging" | "active" | "disabled" | "quarantined";
          revision: number;
          epoch: number;
        }>(
          `SELECT ref,owner_ref,profile,display_name,state,revision,epoch FROM ag_kernel.accounts
          WHERE consumer=$1 AND ref=$2 FOR UPDATE`,
          [ctx.consumerId, accountRef],
        )
      ).rows[0];
      if (!account) throw new KernelError("conflict");
      const original =
        operation.state === "applied" &&
        operation.intent_kind === "disable" &&
        operation.intent_target === accountRef &&
        operation.account_ref === accountRef &&
        Number.isSafeInteger(operation.revision) &&
        Number.isSafeInteger(operation.epoch);
      const metadataRevision = operation.revision,
        authorizationEpoch = operation.epoch;
      if (
        !original ||
        typeof metadataRevision !== "number" ||
        typeof authorizationEpoch !== "number"
      )
        throw new KernelError("conflict");
      const row = (
        await db.query<{
          retained_generations: number;
          settled_native_erasure_generations: number;
          unbound_generations: number;
          retained_executions: number;
          open_executions: number;
          requests: number;
          occupied_transports: number;
          acknowledged_native_transports: number;
          positive_kernel_non_entry_requests: number;
          unknown_effects: number;
          outstanding_intents: number;
        }>(
          `SELECT
          (SELECT count(*)::integer FROM ag_kernel.candidates c WHERE c.consumer=$1 AND c.account_ref=$2) AS retained_generations,
          (SELECT count(*)::integer FROM ag_kernel.candidates c WHERE c.consumer=$1 AND c.account_ref=$2
            AND c.state='retired' AND EXISTS (SELECT 1 FROM ag_kernel.cleanup j WHERE j.consumer=c.consumer
              AND j.generation=c.generation AND j.state='done')) AS settled_native_erasure_generations,
          (SELECT count(*)::integer FROM ag_kernel.candidates c WHERE c.consumer=$1 AND c.account_ref=$2
            AND NOT EXISTS (SELECT 1 FROM ag_management.candidate_journal j JOIN ag_management.physical_mappings m
              ON m.consumer=j.consumer AND m.generation=j.generation
              WHERE j.consumer=c.consumer AND j.generation=c.generation)) AS unbound_generations,
          (SELECT count(*)::integer FROM ag_kernel.executions e WHERE e.consumer=$1 AND e.account_ref=$2) AS retained_executions,
          (SELECT count(*)::integer FROM ag_kernel.executions e WHERE e.consumer=$1 AND e.account_ref=$2
            AND e.state='open') AS open_executions,
          (SELECT count(*)::integer FROM ag_kernel.requests r JOIN ag_kernel.executions e
            ON e.consumer=r.consumer AND e.ref=r.execution_ref WHERE r.consumer=$1 AND e.account_ref=$2) AS requests,
          (SELECT count(*)::integer FROM ag_kernel.requests r JOIN ag_kernel.executions e
            ON e.consumer=r.consumer AND e.ref=r.execution_ref
            WHERE r.consumer=$1 AND e.account_ref=$2 AND r.transport_occupied) AS occupied_transports,
          (SELECT count(*)::integer FROM ag_kernel.requests r JOIN ag_kernel.executions e
            ON e.consumer=r.consumer AND e.ref=r.execution_ref WHERE r.consumer=$1 AND e.account_ref=$2
            AND r.effect NOT IN ('not_dispatched','rejected_before_dispatch')
            AND NOT r.transport_occupied AND r.closure_token IS NOT NULL
            AND r.native_origin_ref IS NOT NULL AND r.engine_incarnation IS NOT NULL
            AND r.request_nonce IS NOT NULL AND r.descriptor_generation IS NOT NULL) AS acknowledged_native_transports,
          (SELECT count(*)::integer FROM ag_kernel.requests r JOIN ag_kernel.executions e
            ON e.consumer=r.consumer AND e.ref=r.execution_ref WHERE r.consumer=$1 AND e.account_ref=$2
            AND r.effect IN ('not_dispatched','rejected_before_dispatch')) AS positive_kernel_non_entry_requests,
          (SELECT count(*)::integer FROM ag_kernel.requests r JOIN ag_kernel.executions e
            ON e.consumer=r.consumer AND e.ref=r.execution_ref
            WHERE r.consumer=$1 AND e.account_ref=$2 AND r.effect='effect_unknown') AS unknown_effects,
          (SELECT count(*)::integer FROM ag_management.transient_intents i WHERE i.consumer=$1
            AND i.account_ref=$2 AND i.ciphertext IS NOT NULL) AS outstanding_intents`,
          [ctx.consumerId, accountRef],
        )
      ).rows[0];
      const counts = Object.freeze({
        retainedGenerations: row.retained_generations,
        settledNativeErasureGenerations: row.settled_native_erasure_generations,
        retainedExecutions: row.retained_executions,
        openExecutions: row.open_executions,
        requests: row.requests,
        occupiedTransports: row.occupied_transports,
        acknowledgedNativeTransports: row.acknowledged_native_transports,
        positiveKernelNonEntryRequests: row.positive_kernel_non_entry_requests,
        unknownEffects: row.unknown_effects,
      });
      const fence = Object.freeze({ metadataRevision, authorizationEpoch });
      const dtoAccount = Object.freeze({
        accountRef: account.ref,
        ownerRef: account.owner_ref,
        profile: account.profile,
        displayName: account.display_name,
        state: account.state,
        revision: account.revision,
        epoch: account.epoch,
      });
      const snapshot =
        account.state === "disabled" &&
        account.revision === metadataRevision &&
        account.epoch === authorizationEpoch;
      const complete =
        snapshot &&
        counts.retainedGenerations > 0 &&
        counts.settledNativeErasureGenerations === counts.retainedGenerations &&
        row.unbound_generations === 0 &&
        counts.openExecutions === 0 &&
        counts.occupiedTransports === 0 &&
        counts.acknowledgedNativeTransports + counts.positiveKernelNonEntryRequests ===
          counts.requests &&
        row.outstanding_intents === 0;
      return Object.freeze({
        operationRef: operationId,
        account: dtoAccount,
        state: !snapshot
          ? ("rejected" as const)
          : complete
            ? ("completed" as const)
            : ("pending" as const),
        fence,
        counts,
        inert: complete,
      });
    });
  }
  async policyClosure(context: TrustedContext, operationId: string) {
    const ctx = captureContext(context);
    identifier(operationId);
    return this.tx(ctx.consumerId, async (db) => {
      const op = (
        await db.query<{ state: string; kind: string; subject: string; revision: number }>(
          `SELECT state,intent->>'kind' AS kind,intent->>'subject' AS subject,intent->'revision' AS revision
          FROM ag_kernel.operations WHERE consumer=$1 AND id=$2`,
          [ctx.consumerId, operationId],
        )
      ).rows[0];
      if (!op) return undefined;
      if (
        op.state !== "applied" ||
        op.kind !== "fence" ||
        !Number.isSafeInteger(op.revision) ||
        op.revision < 0
      )
        throw new KernelError("conflict");
      identifier(op.subject);
      const current = (
        await db.query<{ revision: string }>(
          `SELECT revision::text FROM ag_kernel.policy_fences
        WHERE consumer=$1 AND subject=$2`,
          [ctx.consumerId, op.subject],
        )
      ).rows[0];
      if (!current || Number(current.revision) < op.revision) throw new KernelError("conflict");
      // The original immutable fence chooses the whole cohort. No account,
      // owner, execution list or caller-supplied policy selector can truncate it.
      const counts = (
        await db.query<{
          retainedExecutions: number;
          openExecutions: number;
          requests: number;
          occupiedTransports: number;
          acknowledgedNativeTransports: number;
          positiveKernelNonEntryRequests: number;
          unknownEffects: number;
        }>(
          `WITH chosen_executions AS (
          SELECT ref,state FROM ag_kernel.executions
          WHERE consumer=$1 AND policy_subject=$2 AND policy_revision<=$3
        ), chosen_requests AS (
          SELECT r.* FROM ag_kernel.requests r JOIN chosen_executions e ON e.ref=r.execution_ref WHERE r.consumer=$1
        ) SELECT
          (SELECT count(*)::integer FROM chosen_executions) AS "retainedExecutions",
          (SELECT count(*)::integer FROM chosen_executions WHERE state='open') AS "openExecutions",
          (SELECT count(*)::integer FROM chosen_requests) AS requests,
          (SELECT count(*)::integer FROM chosen_requests WHERE transport_occupied) AS "occupiedTransports",
          (SELECT count(*)::integer FROM chosen_requests WHERE effect NOT IN ('not_dispatched','rejected_before_dispatch')
            AND NOT transport_occupied AND closure_token IS NOT NULL AND native_origin_ref IS NOT NULL
            AND engine_incarnation IS NOT NULL AND request_nonce IS NOT NULL AND descriptor_generation IS NOT NULL) AS "acknowledgedNativeTransports",
          (SELECT count(*)::integer FROM chosen_requests WHERE effect IN ('not_dispatched','rejected_before_dispatch')) AS "positiveKernelNonEntryRequests",
          (SELECT count(*)::integer FROM chosen_requests WHERE effect='effect_unknown') AS "unknownEffects"`,
          [ctx.consumerId, op.subject, op.revision],
        )
      ).rows[0];
      const closed =
        counts.openExecutions === 0 &&
        counts.occupiedTransports === 0 &&
        counts.acknowledgedNativeTransports + counts.positiveKernelNonEntryRequests ===
          counts.requests;
      // Zero uses is positive only because the exact applied fence is known and
      // this consumer lock excludes a concurrent accepted old-policy dispatch.
      return Object.freeze({
        operationRef: operationId,
        policySubject: op.subject,
        policyRevision: op.revision,
        state: closed ? ("completed" as const) : ("pending" as const),
        counts: Object.freeze(counts),
        closed,
      });
    });
  }
  async oauthCleanup(
    context: TrustedContext,
    worker: string,
    input: OAuthCleanupAuthority,
    action: OAuthCleanupAction,
    source: ManagedProfile,
    selectors?: OAuthSelectors,
  ): Promise<OAuthCleanupScope | undefined> {
    const ctx = captureContext(context),
      p = refreshProfile(source);
    const authority = Object.freeze({
      cleanupRef: input.cleanupRef,
      cleanupToken: input.cleanupToken,
    });
    const s =
      selectors &&
      Object.freeze({
        consumerId: selectors.consumerId,
        operationId: selectors.operationId,
        accountRef: selectors.accountRef,
        generation: selectors.generation,
      });
    uuid(worker);
    uuid(authority.cleanupRef);
    uuid(authority.cleanupToken);
    if (!["read", "erase"].includes(action)) throw new KernelError("invalid");
    if (s) {
      identifier(s.operationId);
      uuid(s.accountRef);
      uuid(s.generation);
      if (s.consumerId !== ctx.consumerId) throw new KernelError("denied");
    }
    return this.tx(ctx.consumerId, async (db) => {
      const r = (
        await db.query<
          JournalRow &
            Partial<MappingRow> & { native_identity: string | null; lease_expires_at: string }
        >(
          `
        SELECT j.*,m.native_physical_identity,m.native_id,m.native_created_at,c.native_identity,
          to_char(l.lease_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS lease_expires_at
        FROM ag_kernel.cleanup l JOIN ag_kernel.candidates c ON c.consumer=l.consumer AND c.generation=l.generation
        JOIN ag_management.candidate_journal j ON j.consumer=c.consumer AND j.generation=c.generation
          AND j.operation_id=c.operation_id AND j.account_ref=c.account_ref AND j.profile=c.profile AND j.worker=c.worker
        JOIN ag_kernel.accounts a ON a.consumer=j.consumer AND a.ref=j.account_ref AND a.owner_ref=j.owner_ref AND a.profile=j.profile
        JOIN ag_kernel.operations o ON o.consumer=j.consumer AND o.id=j.operation_id AND o.account_ref=j.account_ref
        LEFT JOIN ag_management.physical_mappings m ON m.consumer=j.consumer AND m.generation=j.generation
        WHERE l.consumer=$1 AND l.ref=$2 AND l.worker=$3 AND l.token=$4 AND l.state='claimed'
          AND l.lease_until>clock_timestamp() AND j.profile=$5 AND j.base_url=$6 AND j.model=ANY($7::text[]) AND j.qualification_ref=$8
          AND j.purpose IN ('create','reconnect') AND o.intent->>'kind'=j.purpose
          AND c.state IN ('ready','quarantined') AND o.state IN ('applied','unknown')
          AND ((j.purpose='create' AND o.intent->>'owner'=j.owner_ref AND o.intent->>'profile'=j.profile)
            OR (j.purpose='reconnect' AND o.intent->>'target'=j.account_ref::text))
          AND NOT (a.state IN ('active','suspended') AND a.active_generation=j.generation)
          AND EXISTS (SELECT 1 FROM ag_kernel.workers w WHERE w.consumer=l.consumer AND w.worker=$3 AND w.lease_until>clock_timestamp())
          AND ($9::text IS NULL OR j.operation_id=$9 AND j.account_ref=$10 AND j.generation=$11)
          AND ($12::boolean=false OR NOT EXISTS (SELECT 1 FROM ag_kernel.requests r
            JOIN ag_kernel.executions e ON e.consumer=r.consumer AND e.ref=r.execution_ref
            WHERE r.consumer=l.consumer AND e.generation=l.generation AND r.transport_occupied))`,
          [
            ctx.consumerId,
            authority.cleanupRef,
            worker,
            authority.cleanupToken,
            p.profile,
            p.baseURL,
            oauthProfileDefinition(p.profile)!.cleanupModels,
            p.qualificationRef,
            s?.operationId ?? null,
            s?.accountRef ?? null,
            s?.generation ?? null,
            action === "erase",
          ],
        )
      ).rows[0];
      if (!r) return undefined;
      const journal = journalRow(r);
      // A saved mapping is not erasure authority until the kernel bound the
      // exact proof. Read can recover that gap without deleting a discovered row.
      if (
        r.native_identity &&
        (r.native_identity !== journal.generation || !r.native_physical_identity)
      )
        throw new KernelError("conflict");
      const native = r.native_physical_identity
        ? mappingRow(r as MappingRow).descriptor
        : undefined;
      return Object.freeze({
        journal,
        leaseExpiresAt: r.lease_expires_at,
        ...(native && r.native_identity ? { native } : {}),
      });
    });
  }
  async expire(context: TrustedContext): Promise<readonly CandidateJournal[]> {
    const ctx = captureContext(context);
    return this.tx(ctx.consumerId, async (db) => {
      const expired = await db.query(
        `UPDATE ag_management.transient_intents i SET nonce=NULL,ciphertext=NULL,tag=NULL
        WHERE (consumer,operation_id) IN (SELECT consumer,operation_id FROM ag_management.transient_intents
          WHERE consumer=$1 AND expires_at<=clock_timestamp() AND ciphertext IS NOT NULL ORDER BY expires_at LIMIT $2)
        RETURNING operation_id`,
        [ctx.consumerId, this.batch],
      );
      const ids = expired.rows.map((r: { operation_id: string }) => r.operation_id);
      const journals = (
        await db.query<JournalRow>(
          `SELECT j.* FROM ag_management.candidate_journal j
        JOIN ag_kernel.candidates c ON c.consumer=j.consumer AND c.generation=j.generation
        WHERE j.consumer=$1 AND j.operation_id=ANY($2::text[]) AND c.state='creating'`,
          [ctx.consumerId, ids],
        )
      ).rows.map(journalRow);
      // Erased staged intents are tombstones until the kernel settles them. Saturate, never revive/evict unresolved evidence.
      await db.query(
        `DELETE FROM ag_management.transient_intents i WHERE (consumer,operation_id) IN
        (SELECT i.consumer,i.operation_id FROM ag_management.transient_intents i JOIN ag_kernel.operations o
          ON o.consumer=i.consumer AND o.id=i.operation_id WHERE i.consumer=$1 AND i.ciphertext IS NULL
          AND o.state IN ('applied','rejected','unknown') ORDER BY i.expires_at LIMIT $2)`,
        [ctx.consumerId, this.batch],
      );
      return journals;
    });
  }
}
