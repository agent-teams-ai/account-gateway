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
export const oauthReconnect = c.oauthReconnect;
/** Sensitive callback ingress. Never retain this URL in account/operation data. */
export const oauthCallbackState = z.string().regex(/^[0-9a-f]{64}$/);
export const oauthCallbackCode = z.string().min(1).max(4096).refine(value =>
  !/[\uD800-\uDFFF]/u.test(value) && new TextEncoder().encode(value).byteLength <= 4096 &&
  !/[\u0000-\u001f\u007f-\u009f]/u.test(value) &&
  !/^[\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]|[\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/u.test(value));
// Parse raw names before decoding values: aliases, duplicates, malformed UTF-8
// and URL normalization must never redirect a callback into another intent.
export function parseOAuthCallbackURL(value: unknown): { readonly state: string; readonly code: string } | undefined {
  try {
    const prefix = 'http://localhost:1455/auth/callback?';
    if (typeof value !== 'string' || /[\uD800-\uDFFF]/u.test(value) || value.length > 8192 ||
        new TextEncoder().encode(value).byteLength > 8192 || !value.startsWith(prefix) ||
        /[\u0000-\u0020\u007f-\u009f#\\]/u.test(value)) return undefined;
    const fields = new Map<string, string>();
    for (const part of value.slice(prefix.length).split('&')) {
      const equal = part.indexOf('=');
      if (equal < 1) return undefined;
      const key = part.slice(0, equal);
      if (!['code', 'state', 'scope'].includes(key) || fields.has(key)) return undefined;
      fields.set(key, decodeURIComponent(part.slice(equal + 1).replace(/\+/g, ' ')));
    }
    const code = fields.get('code'), state = fields.get('state'), scope = fields.get('scope');
    if (!oauthCallbackCode.safeParse(code).success || !oauthCallbackState.safeParse(state).success ||
        (scope !== undefined && new TextEncoder().encode(scope).byteLength > 1024)) return undefined;
    return { code: code!, state: state! };
  } catch { return undefined; }
}
export const oauthCallbackURL = z.string().min(1).max(8192).refine(value => parseOAuthCallbackURL(value) !== undefined);
export const oauthComplete = z.strictObject({ operationId: c.reference, ownerRef: c.reference, callbackURL: oauthCallbackURL });
export type OAuthComplete = z.infer<typeof oauthComplete>;

/** Approved native bytes are never parsed or converted into a generic protocol DTO. */
export const nativeRequest = z.strictObject({ requestId: c.reference, admission: c.admission, body: z.instanceof(Uint8Array) })
  .refine(value => value.body.byteLength <= value.admission.limits.requestBytes);
