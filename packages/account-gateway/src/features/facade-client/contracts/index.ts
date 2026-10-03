import { z } from 'zod';
/** Single facade v1 authority: positive allowlists; no native/product models. */
export const reference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
export const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const deadline = z.iso.datetime({ offset: true }).max(64);
export const protocol = z.enum(['openai-chat', 'openai-responses', 'anthropic-messages']);
export const accountState = z.enum(['staging', 'active', 'quarantined', 'rejected', 'disabled', 'tombstoned']);
export const executionState = z.enum(['active', 'fenced', 'terminal']);
export const effectState = z.enum(['not_dispatched', 'dispatch_started', 'response_started', 'completed', 'effect_unknown']);
export const errorCode = z.enum(['invalid_request', 'unauthenticated', 'forbidden', 'not_found', 'conflict', 'admission_limited', 'upstream_failure', 'internal_error']);
export const safeError = z.strictObject({ code: errorCode, traceRef: reference, operationRef: reference.optional(), requestRef: reference.optional(), effect: effectState,
  retry: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('never') }), z.strictObject({ kind: z.literal('readback') }), z.strictObject({ kind: z.literal('after'), milliseconds: z.number().int().min(0).max(3600000) })]),
}).refine(v => v.retry.kind !== 'after' || v.effect === 'not_dispatched');
export const profile = z.strictObject({ profileId: reference, protocol, modelIds: z.array(z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)).min(1).max(128), authKinds: z.array(z.enum(['api_key', 'oauth'])).min(1).max(2) });
export const profiles = z.strictObject({ profiles: z.array(profile).max(128) });
export const account = z.strictObject({ accountRef: reference, ownerRef: reference, profileId: reference, displayName: z.string().min(1).max(128), state: accountState, metadataRevision: revision, authorizationEpoch: revision });
export const listQuery = z.strictObject({ ownerRef: reference.optional(), cursor: reference.optional(), limit: z.number().int().min(1).max(100).optional() });
export const accounts = z.strictObject({ accounts: z.array(account).max(100), nextCursor: reference.optional() });
export const accountResult = z.strictObject({ kind: z.literal('account'), accountRef: reference, metadataRevision: revision, authorizationEpoch: revision });
export const executionResult = z.strictObject({ kind: z.literal('execution'), executionRef: reference, deadline, state: executionState });
export const operation = z.discriminatedUnion('state', [
  z.strictObject({ operationRef: reference, state: z.literal('pending') }),
  z.strictObject({ operationRef: reference, state: z.literal('applied'), result: z.discriminatedUnion('kind', [accountResult, executionResult]).optional() }),
  z.strictObject({ operationRef: reference, state: z.literal('rejected'), error: safeError }),
  z.strictObject({ operationRef: reference, state: z.literal('unknown'), error: safeError.optional() }),
]);
export const accountOperation = operation.refine(v => v.state !== 'applied' || v.result?.kind === 'account');
export const preparationOperation = operation.refine(v => v.state !== 'applied' || v.result?.kind === 'execution');
export const acknowledgementOperation = operation.refine(v => v.state !== 'applied' || !v.result);
export const execution = z.strictObject({ executionRef: reference, accountRef: reference, authorizationEpoch: revision, profileId: reference, deadline, state: executionState });
export const requestStatus = z.strictObject({ requestRef: reference, effect: effectState, status: z.enum(['pending', 'completed', 'cancelled', 'failed', 'unknown']), error: safeError.optional() });
export const limits = z.strictObject({ requests: z.number().int().min(1).max(10000), requestBytes: z.number().int().min(1).max(16777216), outputBytes: z.number().int().min(1).max(67108864), tokens: z.number().int().min(1).max(10000000), concurrency: z.number().int().min(1).max(128) });
export const prepare = z.strictObject({ operationId: reference, invocationRef: reference, attemptRef: reference, accountRefs: z.array(reference).min(1).max(100), subjectRef: reference, policyRevision: revision, profileId: reference, limits, deadline });
export const rename = z.strictObject({ operationId: reference, expectedMetadataRevision: revision, displayName: z.string().min(1).max(128) });
export const disable = z.strictObject({ operationId: reference, expectedMetadataRevision: revision });
export const close = z.strictObject({ operationId: reference, reason: z.enum(['completed', 'cancelled', 'failed', 'deadline', 'revoked']) });
export const fence = z.strictObject({ operationId: reference, subjectRef: reference, revision });
export const admission = z.strictObject({ invocationRef: reference, attemptRef: reference, accountRef: reference, authorizationEpoch: revision, subjectRef: reference, policyRevision: revision, bindingRevision: revision, profileId: reference, limits, expiresAt: deadline });
export type Profile = z.infer<typeof profile>;
export type Account = z.infer<typeof account>;
export type Operation = z.infer<typeof operation>;
export type Execution = z.infer<typeof execution>;
export type RequestStatus = z.infer<typeof requestStatus>;
export type SafeError = z.infer<typeof safeError>;
export type Prepare = z.infer<typeof prepare>;
export type Rename = z.infer<typeof rename>;
export type Disable = z.infer<typeof disable>;
export type Close = z.infer<typeof close>;
export type Fence = z.infer<typeof fence>;
export type Admission = z.infer<typeof admission>;
export type ListQuery = z.infer<typeof listQuery>;
