import { AITranslatorConfig } from './translator';
import { RealtimeSubtitleTranslator, TimedText } from './realtimeTranslator';

/**
 * In-memory link between an AI-translated subtitle entity and the source material
 * it is derived from. Kept out of the persisted subtitle DB on purpose: it holds
 * the API key and the (potentially large) source cues, and AI subtitles are
 * regenerated per session rather than stored.
 */
interface RegistryEntry {
  sourceCues: TimedText[];
  config: AITranslatorConfig;
  translator?: RealtimeSubtitleTranslator;
}

const registry = new Map<string, RegistryEntry>();

/** Stable key so the same reference + target language always maps to one entry. */
export function makeAITranslationKey(referenceHash: string, targetLanguage: string): string {
  return `${referenceHash}::${targetLanguage}`;
}

export function registerAITranslation(
  key: string,
  sourceCues: TimedText[],
  config: AITranslatorConfig,
): void {
  const existing = registry.get(key);
  if (existing) existing.translator?.dispose();
  registry.set(key, { sourceCues, config });
}

export function hasAITranslation(key: string): boolean {
  return registry.has(key);
}

/** Lazily builds (and memoizes) the realtime translator for a registered entry. */
export function getAITranslator(key: string): RealtimeSubtitleTranslator | undefined {
  const entry = registry.get(key);
  if (!entry) return undefined;
  if (!entry.translator) {
    entry.translator = new RealtimeSubtitleTranslator(entry.sourceCues, entry.config);
  }
  return entry.translator;
}

export function clearAITranslation(key: string): void {
  const entry = registry.get(key);
  if (entry) {
    entry.translator?.dispose();
    registry.delete(key);
  }
}
