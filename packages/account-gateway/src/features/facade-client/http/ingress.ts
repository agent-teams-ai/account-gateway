import { z } from 'zod';
import * as c from '../contracts/index.js';
// Secret ingress is deliberately absent from the browser-safe contracts entry.
export const credential = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('api_key'), value: z.string().min(1).max(16384) }),
  z.strictObject({ kind: z.literal('oauth'), accessToken: z.string().min(1).max(16384), refreshToken: z.string().min(1).max(16384), expiresAt: c.deadline }),
]);
export const connect = z.strictObject({ operationId: c.reference, ownerRef: c.reference, profileId: c.reference,
  displayName: z.string().min(1).max(128), credential });
export const reconnect = z.strictObject({ operationId: c.reference, expectedMetadataRevision: c.revision, credential });
// Additive PKCE enrollment uses the v1 authority, never the historical raw
// OAuth credential DTO above. That DTO does not implement a login flow.
export const oauthBegin = c.oauthBegin;

/** Approved native bytes are never parsed or converted into a generic protocol DTO. */
export const nativeRequest = z.strictObject({ requestId: c.reference, admission: c.admission, body: z.instanceof(Uint8Array) })
  .refine(value => value.body.byteLength <= value.admission.limits.requestBytes);
