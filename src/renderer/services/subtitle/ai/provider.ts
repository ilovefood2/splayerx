/**
 * Decides whether translation uses SPlayer's managed Qwen3 endpoint or a
 * user-configured OpenAI-compatible API.
 *
 * NOTE: explicit `=== undefined` checks keep this compatible with the
 * project's legacy TypeScript/Babel toolchain.
 */

import { AITranslatorConfig, DEFAULT_BASE_URL, DEFAULT_MODEL } from './translator';
import { ManagedModelEndpoint } from './managedModel';

export type AIProviderPreference = 'auto' | 'openai' | 'local';

export type AIProviderKind = 'openai' | 'local';

export type AIProviderReason =
  | 'user-key'
  | 'user-endpoint'
  | 'local-ready'
  | 'local-model-missing'
  | 'local-runtime-missing'
  | 'local-start-failed'
  | 'missing-key';

export interface AIProviderPrefs {
  aiTranslateProvider?: AIProviderPreference;
  aiTranslateApiUrl?: string;
  aiTranslateApiKey?: string;
  aiTranslateModel?: string;
  aiTranslateManagedModel?: string;
}

/**
 * Overrides for `RealtimeSubtitleTranslator` that depend on the provider.
 * A local model is far slower than a hosted one, so it needs a longer request
 * timeout and a bigger head start.
 */
export interface AIProviderTuning {
  requestTimeout?: number;
  lookaheadSeconds?: number;
}

export interface AIProviderResolution {
  ok: boolean;
  kind?: AIProviderKind;
  reason: AIProviderReason;
  /** Present when ok. */
  endpoint?: { baseUrl: string, apiKey: string, model: string };
  tuning: AIProviderTuning;
}

/**
 * Measured against local Qwen3 on this project's own prompt: a 16-line batch
 * takes ~5s on a non-thinking model and ~30s on a thinking one, plus up to ~30s
 * to load a cold model. The stock 30s request timeout and 20s lookahead are both
 * too tight for that.
 */
export const LOCAL_TUNING: AIProviderTuning = {
  requestTimeout: 120000,
  lookaheadSeconds: 90,
};

export function isLocalhostUrl(url?: string): boolean {
  if (!url) return false;
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(url.trim());
}

/**
 * Work out where to send translation requests.
 *
 * - A configured API key is always honoured, and costs no probe.
 * - Otherwise we use SPlayer's managed local Qwen3 runtime.
 * - With neither, we report why instead of firing an unauthenticated request at
 *   OpenAI (which would 401 and permanently disable translation for the session,
 *   after having already sent the subtitle text off the machine).
 */
function remoteResolution(
  prefs: AIProviderPrefs,
  reason: AIProviderReason,
  apiKey: string,
): AIProviderResolution {
  const baseUrl = prefs.aiTranslateApiUrl || DEFAULT_BASE_URL;
  return {
    ok: true,
    kind: 'openai',
    reason,
    endpoint: { baseUrl, apiKey, model: prefs.aiTranslateModel || DEFAULT_MODEL },
    // A key pointed at localhost is still a local model (e.g. LM Studio).
    tuning: isLocalhostUrl(baseUrl) ? LOCAL_TUNING : {},
  };
}

/** The remote decision, or undefined when we should look for a local model. */
function resolveRemote(prefs: AIProviderPrefs): AIProviderResolution | undefined {
  const provider: AIProviderPreference = prefs.aiTranslateProvider || 'auto';
  if (provider === 'local') return undefined;
  const apiKey = prefs.aiTranslateApiKey || '';
  if (apiKey) return remoteResolution(prefs, 'user-key', apiKey);
  if (provider !== 'openai') return undefined;
  // The user explicitly chose the hosted API. A keyless endpoint they typed
  // themselves is legitimate (a gateway); an implicit api.openai.com is not.
  if (prefs.aiTranslateApiUrl) return remoteResolution(prefs, 'user-endpoint', '');
  return { ok: false, reason: 'missing-key', tuning: {} };
}

export async function resolveAIProvider(
  prefs: AIProviderPrefs,
  options: {
    localEndpoint?: ManagedModelEndpoint,
    localReason?: 'local-model-missing' | 'local-runtime-missing' | 'local-start-failed',
  } = {},
): Promise<AIProviderResolution> {
  const remote = resolveRemote(prefs);
  if (remote) return remote;
  if (options.localEndpoint) {
    return {
      ok: true,
      kind: 'local',
      reason: 'local-ready',
      endpoint: {
        baseUrl: options.localEndpoint.baseUrl,
        apiKey: '',
        model: options.localEndpoint.model,
      },
      tuning: LOCAL_TUNING,
    };
  }
  return {
    ok: false,
    reason: options.localReason || 'local-model-missing',
    tuning: {},
  };
}

/** Build the translator config for a resolved provider. */
export function configFor(
  resolution: AIProviderResolution,
  languages: { targetLanguage: string, sourceLanguage?: string },
): AITranslatorConfig | undefined {
  if (!resolution.ok || !resolution.endpoint) return undefined;
  return {
    baseUrl: resolution.endpoint.baseUrl,
    apiKey: resolution.endpoint.apiKey,
    model: resolution.endpoint.model,
    targetLanguage: languages.targetLanguage,
    sourceLanguage: languages.sourceLanguage,
  };
}
