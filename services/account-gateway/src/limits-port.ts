import * as c from '@agent-teams/account-gateway/contracts';
import { isDeepStrictEqual } from 'node:util';
import { KernelError } from './domain.ts';

export type AccountLimitsSelector = c.AccountLimitsRequest;
export type AccountLimitsWireSource =
  { readonly contract: 'account-limits/v1'; read(input: AccountLimitsSelector): Promise<c.AccountLimits> } |
  { readonly contract: 'account-limits/v2'; read(input: AccountLimitsSelector): Promise<c.AccountLimitsV2> };
export interface AccountLimitsAuthority {
  authorize(input: AccountLimitsSelector): Promise<boolean>;
  currentIdentity(input: AccountLimitsSelector): Promise<unknown>;
}
export type AccountLimitsPortResult = {
  readonly wire: c.AccountLimits | c.AccountLimitsV2;
  readonly consumer: c.ConsumerAccountLimits;
};
/**
 * The sole cached consumer-facing limits port. It owns authorization, both
 * generation/identity fences, unknown preservation and v1/v2 normalization.
 */
export async function readCachedAccountLimits(authority: AccountLimitsAuthority, source: AccountLimitsWireSource | undefined,
  input: AccountLimitsSelector, expected: { readonly contract: 'account-limits/v1' | 'account-limits/v2'; readonly provider?: c.ProviderConnectionCapability['provider']['identity'] }): Promise<AccountLimitsPortResult> {
  const empty = (): AccountLimitsPortResult => ({ wire: { status: 'unsupported' }, consumer: { status: 'unsupported' } });
  if (!await authority.authorize(input)) throw new KernelError('denied');
  if (!source || source.contract !== expected.contract) return empty();
  const before = await authority.currentIdentity(input);
  let result: c.AccountLimits | c.AccountLimitsV2 = { status: 'unavailable' };
  try {
    const observed = await source.read(input);
    const parsed = (source.contract === 'account-limits/v2' ? c.accountLimitsV2 : c.accountLimits).safeParse(observed);
    if (parsed.success) result = parsed.data;
  } catch { /* Preserve the safe union; still revalidate after the await. */ }
  if (result.status === 'snapshot' && expected.provider) {
    const matches = source.contract === 'account-limits/v2'
      ? (result as Extract<c.AccountLimitsV2, { status: 'snapshot' }>).windows.every(window => window.provider === expected.provider)
      : (result as Extract<c.AccountLimits, { status: 'snapshot' }>).windows.every(window =>
        window.family === (expected.provider === 'openai' ? 'codex' : expected.provider === 'anthropic' ? 'claude' : undefined));
    if (!matches) result = { status: 'unavailable' };
  }
  const after = await authority.currentIdentity(input);
  if (!isDeepStrictEqual(before, after) || !await authority.authorize(input)) throw new KernelError('denied');
  return { wire: result, consumer: c.adaptAccountLimits(result, source.contract) };
}
