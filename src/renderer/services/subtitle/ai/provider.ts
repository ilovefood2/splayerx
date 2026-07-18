/**
 * Decides which LLM endpoint the subtitle translator should talk to.
 *
 * The rule the user cares about: if translating would require an API key they
 * have not given us, use their local Ollama instead of failing. Resolution
 * happens once, before a translator is constructed, so the rest of the pipeline
 * only ever sees a concrete config and `getCuesAt()` stays synchronous.
 *
 * NOTE: explicit `=== undefined` checks rather than `??`/`?.` — see ollama.ts.
 */

import { AITranslatorConfig, DEFAULT_BASE_URL, DEFAULT_MODEL } from './translator';
import {
  OLLAMA_DEFAULT_BASE_URL, OllamaProbe, apiRootOf, probeOllama,
} from './ollama';

export type AIProviderPreference = 'auto' | 'apple' | 'openai' | 'ollama';

export type AIProviderKind = 'openai' | 'ollama';

export type AIProviderReason =
  | 'user-key'
  | 'user-endpoint'
  | 'ollama-detected'
  | 'ollama-forced'
  | 'missing-key'
  | 'ollama-unreachable'
  | 'ollama-no-chat-model';

export interface AIProviderPrefs {
  aiTranslateProvider?: AIProviderPreference;
  aiTranslateApiUrl?: string;
  aiTranslateApiKey?: string;
  aiTranslateModel?: string;
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
  probe?: OllamaProbe;
}

/**
 * Measured against a local qwen3 on this project's own prompt: a 16-line batch
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

function localEndpoint(probe: OllamaProbe, prefs: AIProviderPrefs) {
  // An explicit model always wins: the user may have pulled something we rank
  // poorly, and second-guessing them here would be surprising.
  const model = prefs.aiTranslateModel || probe.recommended || '';
  return { baseUrl: probe.baseUrl, apiKey: '', model };
}

/**
 * Work out where to send translation requests.
 *
 * - A configured API key is always honoured, and costs no probe.
 * - Otherwise we look for a local Ollama and use it.
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
  if (provider === 'ollama') return undefined;
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
  options: { timeout?: number } = {},
): Promise<AIProviderResolution> {
  const remote = resolveRemote(prefs);
  if (remote) return remote;

  // 'auto' with no key, or 'ollama' explicitly: look for a local model.
  const provider: AIProviderPreference = prefs.aiTranslateProvider || 'auto';
  const apiUrl = prefs.aiTranslateApiUrl || '';
  const forced = provider === 'ollama';
  const base = forced && apiUrl ? apiUrl : OLLAMA_DEFAULT_BASE_URL;
  const probe = await probeOllama(base, options);
  if (probe.available) {
    return {
      ok: true,
      kind: 'ollama',
      reason: forced ? 'ollama-forced' : 'ollama-detected',
      endpoint: localEndpoint(probe, prefs),
      tuning: LOCAL_TUNING,
      probe,
    };
  }
  return {
    ok: false,
    reason: probe.reachable ? 'ollama-no-chat-model' : 'ollama-unreachable',
    tuning: {},
    probe,
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

/** Exposed so the Preferences UI can show the same host it will actually use. */
export function ollamaRootOf(prefs: AIProviderPrefs): string {
  const provider: AIProviderPreference = prefs.aiTranslateProvider || 'auto';
  const apiUrl = prefs.aiTranslateApiUrl || '';
  return apiRootOf(provider === 'ollama' && apiUrl ? apiUrl : OLLAMA_DEFAULT_BASE_URL);
}
