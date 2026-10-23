import { providerConnectionDefinition } from './provider-connections.ts';

// Closed source-owned OAuth tuples. Browser input selects only a configured ID;
// it never supplies native routes, provider endpoints or credential policy.
const codexTuple = providerConnectionDefinition('openai-codex-oauth-responses-v1')!;
const claudeTuple = providerConnectionDefinition('anthropic-claude-oauth-messages-v1')!;
const grokTuple = providerConnectionDefinition('grok-subscription-responses-oauth-v1')!;
export const codexOAuthProfile = Object.freeze({ profile: codexTuple.profileId,
  baseURL: codexTuple.baseURL, model: codexTuple.models[0].modelId });
export const claudeOAuthProfile = Object.freeze({ profile: claudeTuple.profileId,
  baseURL: claudeTuple.baseURL, model: claudeTuple.models[0].modelId });
export const grokOAuthProfile = Object.freeze({ profile: grokTuple.profileId,
  baseURL: grokTuple.baseURL, model: grokTuple.models[0].modelId });
export const codexOAuthCleanupModels: readonly string[] = Object.freeze([codexOAuthProfile.model, 'gpt-6.1-sol']);
const definitions = Object.freeze([
  Object.freeze({ ...codexOAuthProfile, ...codexTuple.oauth! }),
  Object.freeze({ ...claudeOAuthProfile, ...claudeTuple.oauth! }),
  Object.freeze({ ...grokOAuthProfile, ...grokTuple.oauth! }),
]);
export type OAuthProfileDefinition = (typeof definitions)[number];
export function oauthProfileDefinition(profile: string): OAuthProfileDefinition | undefined {
  return definitions.find(value => value.profile === profile);
}
