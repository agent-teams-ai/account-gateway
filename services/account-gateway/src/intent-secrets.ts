import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { KernelError, identifier, uuid } from "./domain.ts";
import type { AcceptedIntent, CandidateScope, IntentCustody } from "./management.ts";

// Transient credential custody: no SQL, transport or logging dependencies.
export interface IntentEnvelope {
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly tag: Buffer;
}
export function scopeCopy(s: CandidateScope): CandidateScope {
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
  if (!["create", "reconnect"].includes(copy.purpose)) {
    throw new KernelError("invalid");
  }
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
    ) {
      throw new KernelError("invalid");
    }
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
    if (typeof apiKey !== "string" || !apiKey.isWellFormed()) {
      throw new KernelError("invalid");
    }
    const plaintext = Buffer.from(apiKey, "utf8");
    try {
      if (plaintext.length < 1 || plaintext.length > 4096) {
        throw new KernelError("invalid");
      }
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
      ) {
        throw new KernelError("unavailable");
      }
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
