// Closed source-owned OAuth tuples. Browser input selects only a configured ID;
// it never supplies native routes, provider endpoints or credential policy.
export const codexOAuthProfile = Object.freeze({ profile: 'openai-codex-oauth-responses-v1',
  baseURL: 'https://chatgpt.com/backend-api/codex', model: 'gpt-5.6-sol' });
export const claudeOAuthProfile = Object.freeze({ profile: 'anthropic-claude-oauth-messages-v1',
  baseURL: 'https://api.anthropic.com', model: 'claude-sonnet-4-6' });
export const codexOAuthCleanupModels: readonly string[] = Object.freeze([codexOAuthProfile.model, 'gpt-6.1-sol']);
const definitions = Object.freeze([
  Object.freeze({ ...codexOAuthProfile, family: 'codex' as const, deviceCode: true,
    nativePath: '/private/native/v1/oauth/connect', refreshPath: '/private/native/v1/oauth/refresh',
    cleanupModels: codexOAuthCleanupModels }),
  Object.freeze({ ...claudeOAuthProfile, family: 'claude' as const, deviceCode: false,
    nativePath: '/private/native/v1/claude/oauth/connect', refreshPath: '/private/native/v1/claude/oauth/refresh',
    cleanupModels: Object.freeze([claudeOAuthProfile.model]) as readonly string[] }),
]);
export type OAuthProfileDefinition = (typeof definitions)[number];
export function oauthProfileDefinition(profile: string): OAuthProfileDefinition | undefined {
  return definitions.find(value => value.profile === profile);
}
