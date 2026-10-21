import { z } from 'zod';
/** Single facade v1 authority: positive allowlists; no native/product models. */
export const reference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
export const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const deadline = z.iso.datetime({ offset: true }).max(64);
export const protocol = z.enum(['openai-chat', 'openai-responses', 'anthropic-messages']);
export const accountState = z.enum(['staging', 'active', 'quarantined', 'rejected', 'disabled', 'tombstoned']);
export const executionState = z.enum(['active', 'fenced', 'terminal']);
export const effectState = z.enum(['not_dispatched', 'dispatch_started', 'response_started', 'completed', 'effect_unknown', 'rejected_before_dispatch']);
export const errorCode = z.enum(['invalid_request', 'unauthenticated', 'forbidden', 'not_found', 'conflict', 'admission_limited', 'upstream_failure', 'internal_error']);
export const safeError = z.strictObject({ code: errorCode, traceRef: reference, operationRef: reference.optional(), requestRef: reference.optional(), effect: effectState,
  retry: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('never') }), z.strictObject({ kind: z.literal('readback') }), z.strictObject({ kind: z.literal('after'), milliseconds: z.number().int().min(0).max(3600000) })]),
}).refine(v => (v.retry.kind !== 'after' || v.effect === 'not_dispatched') &&
  (v.effect !== 'rejected_before_dispatch' || v.retry.kind === 'never'));
export const profile = z.strictObject({ profileId: reference, protocol, modelIds: z.array(z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)).min(1).max(128), authKinds: z.array(z.enum(['api_key', 'oauth'])).min(1).max(2) });
export const profiles = z.strictObject({ profiles: z.array(profile).max(128) });
export const account = z.strictObject({ accountRef: reference, ownerRef: reference, profileId: reference, displayName: z.string().min(1).max(128), state: accountState, metadataRevision: revision, authorizationEpoch: revision });
export const listQuery = z.strictObject({ ownerRef: reference.optional(), cursor: reference.optional(), limit: z.number().int().min(1).max(100).optional() });
export const accounts = z.strictObject({ accounts: z.array(account).max(100), nextCursor: reference.optional() });
export const accountResult = z.strictObject({ kind: z.literal('account'), accountRef: reference, metadataRevision: revision, authorizationEpoch: revision });
export const executionResult = z.strictObject({ kind: z.literal('execution'), executionRef: reference, accountRef: reference, authorizationEpoch: revision, deadline, state: executionState });
export const operation = z.discriminatedUnion('state', [
  z.strictObject({ operationRef: reference, state: z.literal('pending') }),
  z.strictObject({ operationRef: reference, state: z.literal('applied'), result: z.discriminatedUnion('kind', [accountResult, executionResult]).optional() }),
  z.strictObject({ operationRef: reference, state: z.literal('rejected'), error: safeError }),
  z.strictObject({ operationRef: reference, state: z.literal('unknown'), error: safeError.optional() }),
]).refine(v => !('error' in v) || !v.error || (
  (v.error.operationRef === undefined || v.error.operationRef === v.operationRef) &&
  (v.state !== 'unknown' || (v.error.effect !== 'not_dispatched' && v.error.effect !== 'rejected_before_dispatch' && v.error.retry.kind !== 'after')) &&
  (v.error.effect !== 'rejected_before_dispatch' || v.state === 'rejected')
));
export const accountOperation = operation.refine(v => v.state !== 'applied' || v.result?.kind === 'account');
const retirementCounts = z.strictObject({
  retainedGenerations: revision, settledNativeErasureGenerations: revision,
  retainedExecutions: revision, openExecutions: revision, requests: revision,
  occupiedTransports: revision, acknowledgedNativeTransports: revision,
  positiveKernelNonEntryRequests: revision, unknownEffects: revision,
});
/** Safe retirement attestation; counts cover the complete retained account set. */
export const accountRetirement = z.strictObject({
  operationRef: reference, account, state: z.enum(['pending', 'completed', 'rejected']),
  fence: z.strictObject({ metadataRevision: revision, authorizationEpoch: revision }),
  counts: retirementCounts, inert: z.boolean(),
}).refine(v => v.counts.settledNativeErasureGenerations <= v.counts.retainedGenerations &&
  v.counts.openExecutions <= v.counts.retainedExecutions &&
  (v.counts.retainedExecutions > 0 || v.counts.requests === 0) &&
  v.counts.occupiedTransports <= v.counts.requests &&
  v.counts.acknowledgedNativeTransports <= v.counts.requests &&
  v.counts.positiveKernelNonEntryRequests <= v.counts.requests &&
  v.counts.unknownEffects <= v.counts.requests &&
  v.counts.acknowledgedNativeTransports + v.counts.positiveKernelNonEntryRequests <= v.counts.requests &&
  v.counts.acknowledgedNativeTransports + v.counts.occupiedTransports <= v.counts.requests &&
  v.counts.unknownEffects + v.counts.positiveKernelNonEntryRequests <= v.counts.requests &&
  v.inert === (v.state === 'completed'), { message: 'contradictory retirement counts' })
  .refine(v => v.state !== 'completed' || (
    v.account.state === 'disabled' &&
    v.account.metadataRevision === v.fence.metadataRevision &&
    v.account.authorizationEpoch === v.fence.authorizationEpoch &&
    v.counts.retainedGenerations > 0 &&
    v.counts.settledNativeErasureGenerations === v.counts.retainedGenerations &&
    v.counts.openExecutions === 0 && v.counts.occupiedTransports === 0 &&
    v.counts.unknownEffects <= v.counts.acknowledgedNativeTransports &&
    v.counts.acknowledgedNativeTransports + v.counts.positiveKernelNonEntryRequests === v.counts.requests
  ), { message: 'invalid completed retirement' });
export const policyUseClosure = z.strictObject({
  operationRef: reference, policySubject: reference, policyRevision: revision,
  state: z.enum(['pending', 'completed']), closed: z.boolean(),
  counts: retirementCounts.omit({ retainedGenerations: true, settledNativeErasureGenerations: true }),
}).refine(v => v.counts.openExecutions <= v.counts.retainedExecutions &&
  (v.counts.retainedExecutions > 0 || v.counts.requests === 0) &&
  v.counts.unknownEffects <= v.counts.requests &&
  v.counts.acknowledgedNativeTransports + v.counts.positiveKernelNonEntryRequests <= v.counts.requests &&
  v.counts.acknowledgedNativeTransports + v.counts.occupiedTransports <= v.counts.requests &&
  v.counts.unknownEffects + v.counts.positiveKernelNonEntryRequests <= v.counts.requests &&
  v.closed === (v.state === 'completed'))
  .refine(v => !v.closed || (v.counts.openExecutions === 0 && v.counts.occupiedTransports === 0 &&
    v.counts.unknownEffects <= v.counts.acknowledgedNativeTransports &&
    v.counts.acknowledgedNativeTransports + v.counts.positiveKernelNonEntryRequests === v.counts.requests));
/** Reconnect selectors are browser-safe; account owner/profile come from the server. */
export const oauthReconnect = z.strictObject({ operationId: reference, expectedMetadataRevision: revision });
/** Enrollment carries no credential, callback, model or provider-origin input. */
export const oauthBegin = z.strictObject({ operationId: reference, ownerRef: reference,
  profileId: reference, displayName: z.string().min(1).max(128) });
// This is a temporary owner capability, not safe account/operation metadata.
// Validate it without including Zod issues or the original URL in diagnostics.
export const oauthAuthorizationURL = z.string().min(1).max(4096).refine(value => {
  try {
    if (/[^\u0021-\u007e]/.test(value) || value.includes('\\') ||
        !value.startsWith('https://auth.openai.com/oauth/authorize?')) return false;
    const url = new URL(value);
    if (url.origin !== 'https://auth.openai.com' || url.pathname !== '/oauth/authorize' ||
        url.username || url.password || url.hash || value.includes('#')) return false;
    const fixed: Readonly<Record<string, string>> = {
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', response_type: 'code',
      redirect_uri: 'http://localhost:1455/auth/callback', code_challenge_method: 'S256',
      scope: 'openid profile email offline_access',
    };
    const optional: Readonly<Record<string, string>> = {
      id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', originator: 'codex_cli_rs',
    };
    const seen = new Set<string>();
    // Reject percent/case/Unicode aliases in names, invalid escapes in values,
    // empty query members and duplicates before URLSearchParams normalization.
    for (const part of url.search.slice(1).split('&')) {
      const equal = part.indexOf('=');
      if (equal < 1 || /%(?![0-9a-fA-F]{2})/.test(part)) return false;
      const key = part.slice(0, equal);
      if (!/^[a-z_]+$/.test(key) || seen.has(key) ||
          !(Object.hasOwn(fixed, key) || Object.hasOwn(optional, key) || key === 'state' || key === 'code_challenge')) return false;
      seen.add(key);
    }
    for (const [key, expected] of Object.entries(fixed)) if (url.searchParams.get(key) !== expected) return false;
    for (const [key, expected] of Object.entries(optional)) if (seen.has(key) && url.searchParams.get(key) !== expected) return false;
    return /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('code_challenge') ?? '') &&
      /^[A-Za-z0-9_-]{16,512}$/.test(url.searchParams.get('state') ?? '');
  } catch { return false; }
});
/** Only Begin may return a URL; every ordinary read retains the safe union. */
export const oauthBeginResponse = z.strictObject({ operation: accountOperation,
  authorizationURL: oauthAuthorizationURL.optional() })
  .refine(v => v.authorizationURL === undefined || v.operation.state === 'pending');
export const preparationOperation = operation.refine(v => v.state !== 'applied' || v.result?.kind === 'execution');
export const acknowledgementOperation = operation.refine(v => v.state !== 'applied' || !v.result);
export const execution = z.strictObject({ executionRef: reference, accountRef: reference, authorizationEpoch: revision, profileId: reference, deadline, state: executionState });
export const requestStatus = z.strictObject({ requestRef: reference, effect: effectState, status: z.enum(['pending', 'completed', 'cancelled', 'failed', 'unknown']), error: safeError.optional() })
  .refine(v => (v.effect !== 'rejected_before_dispatch' ||
    (v.status === 'failed' && v.error !== undefined && v.error.retry.kind === 'never')) &&
    (v.status !== 'unknown' || v.effect === 'effect_unknown') &&
    (v.status !== 'completed' || v.effect === 'completed') && (!v.error || (
    (v.error.requestRef === undefined || v.error.requestRef === v.requestRef) &&
    v.error.effect === v.effect &&
    (v.status !== 'unknown' || v.error.retry.kind !== 'after')
  )));
export const limits = z.strictObject({ requests: z.number().int().min(1).max(10000), requestBytes: z.number().int().min(1).max(16777216), outputBytes: z.number().int().min(1).max(67108864), tokens: z.number().int().min(1).max(10000000), concurrency: z.number().int().min(1).max(128) });
export const prepare = z.strictObject({ operationId: reference, invocationRef: reference, attemptRef: reference, accountRefs: z.array(reference).min(1).max(100), subjectRef: reference, policyRevision: revision, bindingRevision: revision, profileId: reference, limits, deadline });
export const rename = z.strictObject({ operationId: reference, expectedMetadataRevision: revision, displayName: z.string().min(1).max(128) });
export const disable = z.strictObject({ operationId: reference, expectedMetadataRevision: revision });
/** Versioned opt-in lifecycle authority. This is deliberately not v1 accountState. */
export const LIFECYCLE_CAPABILITY_CONTRACT = 'account-gateway/account-lifecycle/v2' as const;
export const LIFECYCLE_CLIENT_CONTRACT = 'account-gateway-client/account-lifecycle/v2' as const;
export const LIFECYCLE_CAPABILITY_HEADER = 'x-account-gateway-capability' as const;
export const LIFECYCLE_CLIENT_HEADER = 'x-account-gateway-client-contract' as const;
export const lifecycleCapability = z.strictObject({
  contract: z.literal(LIFECYCLE_CAPABILITY_CONTRACT),
  clientContract: z.literal(LIFECYCLE_CLIENT_CONTRACT),
  writeGate: z.enum(['enabled','disabled']),
  operations: z.array(z.enum(['suspend', 'resume'])).length(2).refine(v => v[0] === 'suspend' && v[1] === 'resume'),
  custody: z.strictObject({ contract: z.literal('native-retained-custody/v1'),
    api_key: z.literal('native-attestation-required'), oauth: z.literal('native-attestation-required') }),
});
export const lifecycleTransition = z.strictObject({ operationId: reference, expectedMetadataRevision: revision });
export const lifecycleAccountState = z.enum(['staging', 'active', 'suspended', 'disabled', 'quarantined']);
export const lifecycleAccount = z.strictObject({
  accountRef: reference, ownerRef: reference, profileId: reference, displayName: z.string().min(1).max(128),
  state: lifecycleAccountState, metadataRevision: revision, authorizationEpoch: revision,
  authKind: z.enum(['api_key', 'oauth']),
  resumeCustody: z.enum(['not_applicable', 'verified', 'attention_required']),
});
export const lifecycleAccounts = z.strictObject({ accounts: z.array(lifecycleAccount).max(100), nextCursor: reference.optional() });
export const lifecycleResult = z.strictObject({ kind: z.literal('account_lifecycle'), account: lifecycleAccount });
export const lifecycleIntent = z.strictObject({ action: z.enum(['suspend','resume']), accountRef: reference,
  profileId: reference, expectedMetadataRevision: revision });
export const lifecycleOperation = z.discriminatedUnion('state', [
  z.strictObject({ operationRef: reference, intent: lifecycleIntent, state: z.literal('pending'), account: lifecycleAccount }),
  z.strictObject({ operationRef: reference, intent: lifecycleIntent, state: z.literal('applied'), result: lifecycleResult }),
  z.strictObject({ operationRef: reference, intent: lifecycleIntent, state: z.literal('rejected'), account: lifecycleAccount, error: safeError }),
  z.strictObject({ operationRef: reference, intent: lifecycleIntent, state: z.literal('unknown'), account: lifecycleAccount, error: safeError }),
]).refine(v => {
  const account = v.state === 'applied' ? v.result.account : v.account;
  return v.intent.accountRef === account.accountRef && v.intent.profileId === account.profileId &&
    (v.state !== 'applied' || account.metadataRevision === v.intent.expectedMetadataRevision + 1 &&
      account.state === (v.intent.action === 'suspend' ? 'suspended' : 'active'));
});
export const close = z.strictObject({ operationId: reference, reason: z.enum(['completed', 'cancelled', 'failed', 'deadline', 'revoked']) });
export const fence = z.strictObject({ operationId: reference, subjectRef: reference, revision });
export const admission = z.strictObject({ invocationRef: reference, attemptRef: reference, accountRef: reference, authorizationEpoch: revision, subjectRef: reference, policyRevision: revision, bindingRevision: revision, profileId: reference, limits, expiresAt: deadline });
export type Profile = z.infer<typeof profile>;
export type Account = z.infer<typeof account>;
export type AccountRetirement = z.infer<typeof accountRetirement>;
export type PolicyUseClosure = z.infer<typeof policyUseClosure>;
export type Operation = z.infer<typeof operation>;
export type OAuthReconnect = z.infer<typeof oauthReconnect>;
export type OAuthBegin = z.infer<typeof oauthBegin>;
export type OAuthBeginResponse = z.infer<typeof oauthBeginResponse>;
export type Execution = z.infer<typeof execution>;
export type RequestStatus = z.infer<typeof requestStatus>;
export type SafeError = z.infer<typeof safeError>;
export type Prepare = z.infer<typeof prepare>;
export type Rename = z.infer<typeof rename>;
export type Disable = z.infer<typeof disable>;
export type LifecycleCapability = z.infer<typeof lifecycleCapability>;
export type LifecycleTransition = z.infer<typeof lifecycleTransition>;
export type LifecycleAccount = z.infer<typeof lifecycleAccount>;
export type LifecycleAccounts = z.infer<typeof lifecycleAccounts>;
export type LifecycleOperation = z.infer<typeof lifecycleOperation>;
export type Close = z.infer<typeof close>;
export type Fence = z.infer<typeof fence>;
export type Admission = z.infer<typeof admission>;
export type ListQuery = z.infer<typeof listQuery>;
