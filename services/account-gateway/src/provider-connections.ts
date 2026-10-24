
type Setting<T> = { readonly allowed: readonly T[]; readonly default: T };
type ModelCapability = {
  readonly modelId: string;
  readonly reasoning: Setting<'minimal' | 'low' | 'medium' | 'high' | 'xhigh'> | null;
  readonly fast: Setting<'balanced' | 'fast'> | null;
  readonly tools: Setting<'none' | 'function' | 'function_and_custom'>;
};
export type ProviderConnectionDefinition = {
  readonly profileId: string;
  readonly provider: { readonly identity: 'mimo' | 'openrouter' | 'openai' | 'anthropic' | 'kimi' | 'glm' | 'minimax' | 'grok'; readonly label: string };
  readonly plan: { readonly identity: 'subscription' | 'coding_plan' | 'm_plan' | 'pay_as_you_go' | 'unknown'; readonly label: string };
  readonly region: { readonly identity: 'global' | 'unknown'; readonly label: string };
  readonly protocol: 'openai-chat' | 'openai-responses' | 'anthropic-messages';
  readonly baseURL: string;
  readonly models: readonly ModelCapability[];
  readonly authMethods: readonly ('api_key' | 'oauth_authorization_code' | 'oauth_device_code')[];
  readonly completionInputKind: 'none' | 'callback_url' | 'authorization_code';
  readonly oauthCallbackMode: 'automatic' | 'manual_callback_url' | null;
  readonly reconnect: 'replace_api_key' | 'oauth_reauthorize' | 'none';
  readonly limitsContract: 'none' | 'account-limits/v1' | 'account-limits/v2';
  readonly availability: 'enabled' | 'deployment_configuration_required';
  readonly oauth?: {
    readonly family: 'codex' | 'claude' | 'grok';
    readonly nativePath: string;
    readonly refreshPath: string;
    readonly deviceCode: boolean;
    readonly cleanupModels: readonly string[];
  };
};

const standard = {
  reasoning: { allowed: ['minimal', 'low', 'medium', 'high'], default: 'medium' },
  fast: { allowed: ['balanced'], default: 'balanced' },
  tools: { allowed: ['function'], default: 'function' },
} as const;
const definition = (input: ProviderConnectionDefinition): ProviderConnectionDefinition => Object.freeze({
  ...input, provider: Object.freeze({ ...input.provider }), plan: Object.freeze({ ...input.plan }),
  region: Object.freeze({ ...input.region }), models: Object.freeze(input.models.map(model => Object.freeze({
    ...model, reasoning: model.reasoning && Object.freeze({ ...model.reasoning, allowed: Object.freeze([...model.reasoning.allowed]) }),
    fast: model.fast && Object.freeze({ ...model.fast, allowed: Object.freeze([...model.fast.allowed]) }),
    tools: Object.freeze({ ...model.tools, allowed: Object.freeze([...model.tools.allowed]) }),
  }))),
  authMethods: Object.freeze([...input.authMethods]),
  ...(input.oauth ? { oauth: Object.freeze({ ...input.oauth, cleanupModels: Object.freeze([...input.oauth.cleanupModels]) }) } : {}),
});

/**
 * The only editable provider tuple source. Capability projection, service tuple
 * validation and OAuth route selection all consume these entries. Private URLs
 * remain here and are never copied into a public DTO.
 */
export const providerConnectionRegistry: readonly ProviderConnectionDefinition[] = Object.freeze([
  definition({ profileId: 'openai-responses-apikey-v1', provider: { identity: 'mimo', label: 'MiMo' },
    plan: { identity: 'unknown', label: 'MiMo' }, region: { identity: 'unknown', label: 'Default' },
    protocol: 'openai-responses', baseURL: '', models: [],
    authMethods: ['api_key'], completionInputKind: 'none', oauthCallbackMode: null, reconnect: 'replace_api_key',
    limitsContract: 'none', availability: 'enabled' }),
  definition({ profileId: 'openrouter-openai-responses-apikey-v1', provider: { identity: 'openrouter', label: 'OpenRouter' },
    plan: { identity: 'pay_as_you_go', label: 'OpenRouter credits' }, region: { identity: 'global', label: 'Global' },
    protocol: 'openai-responses', baseURL: 'https://openrouter.ai/api/v1',
    models: [
      { modelId: 'openai/gpt-5.4-mini', ...standard, fast: { allowed: ['balanced', 'fast'], default: 'balanced' } },
      { modelId: 'openai/gpt-5.4-nano', ...standard, fast: { allowed: ['balanced', 'fast'], default: 'fast' } },
    ],
    authMethods: ['api_key'], completionInputKind: 'none', oauthCallbackMode: null, reconnect: 'replace_api_key',
    limitsContract: 'none', availability: 'enabled' }),
  definition({ profileId: 'openai-codex-oauth-responses-v1', provider: { identity: 'openai', label: 'OpenAI Codex' },
    plan: { identity: 'subscription', label: 'ChatGPT subscription' }, region: { identity: 'global', label: 'Global' },
    protocol: 'openai-responses', baseURL: 'https://chatgpt.com/backend-api/codex',
    models: [{ modelId: 'gpt-5.6-sol', ...standard, reasoning: { allowed: ['minimal', 'low', 'medium', 'high', 'xhigh'], default: 'high' } }],
    authMethods: ['oauth_device_code', 'oauth_authorization_code'], completionInputKind: 'callback_url', oauthCallbackMode: 'automatic',
    reconnect: 'oauth_reauthorize', limitsContract: 'account-limits/v1', availability: 'enabled',
    oauth: { family: 'codex', nativePath: '/private/native/v1/oauth/connect',
      refreshPath: '/private/native/v1/oauth/refresh', deviceCode: true, cleanupModels: ['gpt-5.6-sol', 'gpt-6.1-sol'] } }),
  definition({ profileId: 'anthropic-claude-oauth-messages-v1', provider: { identity: 'anthropic', label: 'Anthropic Claude' },
    plan: { identity: 'subscription', label: 'Claude subscription' }, region: { identity: 'global', label: 'Global' },
    protocol: 'openai-responses', baseURL: 'https://api.anthropic.com',
    models: [{ modelId: 'claude-sonnet-4-6', ...standard }], authMethods: ['oauth_authorization_code'],
    completionInputKind: 'authorization_code', oauthCallbackMode: 'manual_callback_url', reconnect: 'oauth_reauthorize',
    limitsContract: 'account-limits/v1', availability: 'enabled',
    oauth: { family: 'claude', nativePath: '/private/native/v1/claude/oauth/connect',
      refreshPath: '/private/native/v1/claude/oauth/refresh', deviceCode: false, cleanupModels: ['claude-sonnet-4-6'] } }),
  definition({ profileId: 'kimi-code-global-responses-apikey-v1', provider: { identity: 'kimi', label: 'Kimi Code' },
    plan: { identity: 'coding_plan', label: 'Kimi Coding Plan' }, region: { identity: 'global', label: 'Global' },
    protocol: 'openai-responses', baseURL: 'https://api.kimi.ai/coding/v1',
    models: [{ modelId: 'k3-256k', ...standard, reasoning: null, fast: null }], authMethods: ['api_key'],
    completionInputKind: 'none', oauthCallbackMode: null, reconnect: 'replace_api_key',
    limitsContract: 'account-limits/v2', availability: 'enabled' }),
  definition({ profileId: 'glm-coding-global-responses-apikey-v1', provider: { identity: 'glm', label: 'GLM Coding Plan' },
    plan: { identity: 'coding_plan', label: 'GLM Coding Plan' }, region: { identity: 'global', label: 'Global' },
    protocol: 'openai-responses', baseURL: 'https://api.z.ai/api/v1',
    models: [{ modelId: 'glm-5.3-flash', ...standard, reasoning: null, fast: null }], authMethods: ['api_key'],
    completionInputKind: 'none', oauthCallbackMode: null, reconnect: 'replace_api_key',
    limitsContract: 'account-limits/v2', availability: 'enabled' }),
  definition({ profileId: 'minimax-mplan-global-responses-apikey-v1', provider: { identity: 'minimax', label: 'MiniMax M Plan' },
    plan: { identity: 'm_plan', label: 'MiniMax M Plan' }, region: { identity: 'global', label: 'Global' },
    protocol: 'openai-responses', baseURL: 'https://api.minimax.io/v1',
    models: [{ modelId: 'MiniMax-M3.1-Flash', ...standard, reasoning: null, fast: null }], authMethods: ['api_key'],
    completionInputKind: 'none', oauthCallbackMode: null, reconnect: 'replace_api_key',
    limitsContract: 'account-limits/v2', availability: 'enabled' }),
  definition({ profileId: 'grok-subscription-responses-oauth-v1', provider: { identity: 'grok', label: 'Grok Subscription' },
    plan: { identity: 'subscription', label: 'Grok subscription' }, region: { identity: 'global', label: 'Global' },
    protocol: 'openai-responses', baseURL: 'https://cli-chat-proxy.grok.com',
    models: [{ modelId: 'grok-4.7', ...standard, reasoning: null, fast: null }], authMethods: ['oauth_authorization_code'],
    completionInputKind: 'authorization_code', oauthCallbackMode: 'manual_callback_url', reconnect: 'oauth_reauthorize',
    limitsContract: 'account-limits/v2', availability: 'enabled',
    oauth: { family: 'grok', nativePath: '/private/native/v1/grok/oauth/connect',
      refreshPath: '/private/native/v1/grok/oauth/refresh', deviceCode: false, cleanupModels: ['grok-4.7'] } }),
]);

const byProfile = new Map(providerConnectionRegistry.map(value => [value.profileId, value]));
export function providerConnectionDefinition(profileId: string): ProviderConnectionDefinition | undefined {
  return byProfile.get(profileId);
}
