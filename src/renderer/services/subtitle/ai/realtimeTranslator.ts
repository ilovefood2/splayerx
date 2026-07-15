import { AITranslatorConfig, translateLines, AITranslationError } from './translator';
import { TranslationCache } from './cache';

/**
 * A minimal cue shape the realtime translator understands. It intentionally
 * mirrors `TextCue` from `@/interfaces/ISubtitle` structurally so the parser can
 * pass its cues straight through without a hard type dependency here.
 */
export interface TimedText {
  start: number;
  end: number;
  text: string;
}

export interface RealtimeTranslatorOptions {
  /** Seconds of subtitle ahead of the playhead to pre-translate. */
  lookaheadSeconds?: number;
  /** Seconds behind the playhead to keep translating (for small seeks back). */
  behindSeconds?: number;
  /** Max source lines per API request. */
  batchSize?: number;
  /** Max concurrent in-flight API requests. */
  maxConcurrentBatches?: number;
  /** Injectable translate function (for testing). Defaults to `translateLines`. */
  translate?: typeof translateLines;
  /** Shared cache instance. A private one is created when omitted. */
  cache?: TranslationCache;
}

type TranslateFn = typeof translateLines;

/**
 * Translates a fixed list of subtitle cues into a target language lazily and in
 * playback order. Cues near the current time are translated ahead of the
 * playhead so that, by the time a cue is shown, its translation is ready. Until
 * then the original text is shown as a graceful fallback.
 */
export class RealtimeSubtitleTranslator {
  private readonly cues: TimedText[];

  private readonly config: AITranslatorConfig;

  private readonly translated: (string | undefined)[];

  private readonly pending: boolean[];

  private readonly cache: TranslationCache;

  private readonly namespace: string;

  private readonly translateFn: TranslateFn;

  private readonly lookahead: number;

  private readonly behind: number;

  private readonly batchSize: number;

  private readonly maxConcurrent: number;

  private activeBatches = 0;

  private consecutiveFailures = 0;

  private disabledUntil = 0;

  private disposed = false;

  private lastError?: Error;

  public constructor(
    cues: TimedText[],
    config: AITranslatorConfig,
    options: RealtimeTranslatorOptions = {},
  ) {
    this.cues = cues
      .filter(cue => cue && typeof cue.text === 'string')
      .slice()
      .sort((a, b) => a.start - b.start);
    this.config = config;
    this.translated = new Array(this.cues.length).fill(undefined);
    this.pending = new Array(this.cues.length).fill(false);
    this.cache = options.cache ?? new TranslationCache();
    this.namespace = `${config.model}|${config.sourceLanguage || 'auto'}|${config.targetLanguage}`;
    this.translateFn = options.translate ?? translateLines;
    this.lookahead = options.lookaheadSeconds ?? 20;
    this.behind = options.behindSeconds ?? 3;
    this.batchSize = options.batchSize ?? 16;
    this.maxConcurrent = options.maxConcurrentBatches ?? 2;
  }

  /** The full ordered cue list, used by the parser to seed video segments. */
  public get sourceCues(): ReadonlyArray<TimedText> {
    return this.cues;
  }

  public get error(): Error | undefined {
    return this.lastError;
  }

  private cacheKey(text: string): string {
    return TranslationCache.keyFor(this.namespace, text);
  }

  private textFor(index: number): string {
    const cue = this.cues[index];
    if (this.translated[index] !== undefined) return this.translated[index] as string;
    const cached = this.cache.get(this.cacheKey(cue.text));
    if (cached !== undefined) {
      this.translated[index] = cached;
      return cached;
    }
    return cue.text; // graceful fallback until translated
  }

  /** All cues with their best currently-known text (translated where available). */
  public getAllCues(): TimedText[] {
    return this.cues.map((cue, i) => ({ start: cue.start, end: cue.end, text: this.textFor(i) }));
  }

  /**
   * Returns the cues overlapping `time`, translated when available, and schedules
   * translation of the surrounding window. Never rejects — translation errors are
   * swallowed so playback is never interrupted (see `error` for diagnostics).
   */
  public getCuesAt(time: number): TimedText[] {
    if (!this.disposed) this.scheduleWindow(time);
    const result: TimedText[] = [];
    for (let i = 0; i < this.cues.length; i += 1) {
      const cue = this.cues[i];
      if (cue.start <= time && cue.end >= time && cue.text) {
        result.push({ start: cue.start, end: cue.end, text: this.textFor(i) });
      }
    }
    return result;
  }

  private isCoolingDown(now: number): boolean {
    return this.disabledUntil > now;
  }

  private collectWindowIndices(time: number): number[] {
    const indices: number[] = [];
    for (let i = 0; i < this.cues.length; i += 1) {
      if (this.translated[i] !== undefined || this.pending[i]) continue;
      const cue = this.cues[i];
      const inWindow = cue.end >= time - this.behind && cue.start <= time + this.lookahead;
      if (!inWindow) continue;
      const cached = this.cache.get(this.cacheKey(cue.text));
      if (cached !== undefined) {
        this.translated[i] = cached;
      } else {
        indices.push(i);
      }
    }
    return indices;
  }

  private scheduleWindow(time: number): void {
    const now = Date.now();
    if (this.isCoolingDown(now)) return;
    const indices = this.collectWindowIndices(time);
    while (indices.length && this.activeBatches < this.maxConcurrent) {
      const batch = indices.splice(0, this.batchSize);
      this.runBatch(batch);
    }
  }

  private runBatch(indices: number[]): void {
    indices.forEach((i) => { this.pending[i] = true; });
    this.activeBatches += 1;

    // Deduplicate identical source lines within the batch to save tokens.
    const uniqueTexts: string[] = [];
    const uniqueIndexOf = new Map<string, number>();
    const slotForIndex = indices.map((i) => {
      const { text } = this.cues[i];
      if (!uniqueIndexOf.has(text)) {
        uniqueIndexOf.set(text, uniqueTexts.length);
        uniqueTexts.push(text);
      }
      return uniqueIndexOf.get(text) as number;
    });

    this.translateFn(uniqueTexts, this.config)
      .then((results) => {
        indices.forEach((cueIndex, k) => {
          const value = results[slotForIndex[k]];
          if (typeof value === 'string') {
            this.translated[cueIndex] = value;
            this.cache.set(this.cacheKey(this.cues[cueIndex].text), value);
          }
        });
        this.consecutiveFailures = 0;
        this.lastError = undefined;
      })
      .catch((e: Error) => {
        this.lastError = e;
        this.consecutiveFailures += 1;
        // Back off exponentially (capped) after repeated failures so a bad key or
        // offline endpoint does not spam requests every poll.
        if (this.consecutiveFailures >= 2) {
          const backoff = Math.min(30000, 1000 * (2 ** this.consecutiveFailures));
          this.disabledUntil = Date.now() + backoff;
        }
        // Do not retry auth/permission errors automatically.
        if (e instanceof AITranslationError && (e.status === 401 || e.status === 403)) {
          this.disabledUntil = Number.MAX_SAFE_INTEGER;
        }
      })
      .finally(() => {
        indices.forEach((i) => { this.pending[i] = false; });
        this.activeBatches -= 1;
      });
  }

  public dispose(): void {
    this.disposed = true;
    this.disabledUntil = Number.MAX_SAFE_INTEGER;
  }
}
