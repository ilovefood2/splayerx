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
  /**
   * Per-request timeout. A local model needs far longer than the client default
   * (a cold load plus a batch can exceed a minute).
   */
  requestTimeout?: number;
  /**
   * Called once if the endpoint rejects our credentials, to obtain a different
   * provider to continue with (in practice: fall back to a local Ollama).
   * Resolving with undefined leaves translation disabled, as before.
   */
  onAuthFailure?: () => Promise<AuthFailover | undefined>;
  /**
   * Show nothing until a cue is translated, rather than falling back to its
   * source text. The AI track is the target-language track: briefly flashing the
   * original and swapping it out reads as a glitch.
   */
  hideUntranslated?: boolean;
}

/** A replacement provider supplied by `onAuthFailure`. */
export interface AuthFailover {
  config: AITranslatorConfig;
  requestTimeout?: number;
  /**
   * The replacement's look-ahead. A local model needs a much bigger window than
   * a hosted one, so failing over without this would leave translations landing
   * after their cues have already been shown.
   */
  lookaheadSeconds?: number;
}

type TranslateFn = typeof translateLines;

function isAuthError(error: Error): boolean {
  if (!(error instanceof AITranslationError)) return false;
  return error.status === 401 || error.status === 403;
}

/**
 * Translates a fixed list of subtitle cues into a target language lazily and in
 * playback order. Cues near the current time are translated ahead of the
 * playhead so that, by the time a cue is shown, its translation is ready. Until
 * then the original text is shown as a graceful fallback.
 */
export class RealtimeSubtitleTranslator {
  private readonly cues: TimedText[];

  /** Not readonly: `onAuthFailure` may swap in a different provider. */
  private config: AITranslatorConfig;

  private readonly translated: (string | undefined)[];

  private readonly pending: boolean[];

  private readonly cache: TranslationCache;

  /** Cache namespace, recomputed whenever `config` changes. */
  private namespace: string;

  private readonly translateFn: TranslateFn;

  /** Not readonly: an auth failover may swap in a provider that needs a bigger window. */
  private lookahead: number;

  private readonly behind: number;

  private readonly batchSize: number;

  private readonly maxConcurrent: number;

  private requestTimeout?: number;

  private readonly hideUntranslated: boolean;

  private readonly onAuthFailure?: () => Promise<AuthFailover | undefined>;

  private activeBatches = 0;

  private consecutiveFailures = 0;

  private disabledUntil = 0;

  private disposed = false;

  private lastError?: Error;

  /**
   * Bumped when the provider is swapped. Batches started under an older
   * generation must not write results, poison the new cache namespace, or
   * re-report an auth error that has already been handled.
   */
  private generation = 0;

  private authFailoverStarted = false;

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
    // Explicit undefined checks rather than `??`: webpack 4 cannot parse `??`,
    // and `||` would discard a deliberate 0 (e.g. lookaheadSeconds: 0).
    this.cache = options.cache === undefined ? new TranslationCache() : options.cache;
    this.namespace = RealtimeSubtitleTranslator.namespaceFor(config);
    this.translateFn = options.translate === undefined ? translateLines : options.translate;
    this.requestTimeout = options.requestTimeout;
    this.onAuthFailure = options.onAuthFailure;
    this.hideUntranslated = options.hideUntranslated === true;
    this.lookahead = options.lookaheadSeconds === undefined ? 20 : options.lookaheadSeconds;
    this.behind = options.behindSeconds === undefined ? 3 : options.behindSeconds;
    this.batchSize = options.batchSize === undefined ? 16 : options.batchSize;
    this.maxConcurrent = options.maxConcurrentBatches === undefined
      ? 2 : options.maxConcurrentBatches;
  }

  private static namespaceFor(config: AITranslatorConfig): string {
    return `${config.model}|${config.sourceLanguage || 'auto'}|${config.targetLanguage}`;
  }

  /** The full ordered cue list, used by the parser to seed video segments. */
  public get sourceCues(): ReadonlyArray<TimedText> {
    return this.cues;
  }

  /**
   * Add cues discovered after construction, as a transcription streams in.
   *
   * Appends only — never reorders. Batches in flight hold cue *indices*, so
   * re-sorting here would make a returning batch write its text onto the wrong
   * cue. Appending keeps every existing index valid, and order does not matter
   * anyway: lookups scan for overlap rather than assuming sorted input.
   */
  public appendCues(cues: TimedText[]): number {
    const incoming = cues.filter(cue => cue && typeof cue.text === 'string' && !!cue.text);
    incoming.forEach((cue) => {
      this.cues.push(cue);
      this.translated.push(undefined);
      this.pending.push(false);
    });
    return incoming.length;
  }

  public get error(): Error | undefined {
    return this.lastError;
  }

  /** The provider currently in use. Changes if an auth failover happened. */
  public get activeModel(): string {
    return this.config.model;
  }

  private cacheKey(text: string): string {
    return TranslationCache.keyFor(this.namespace, text);
  }

  /** The translation, or undefined while it is still pending. */
  private translationFor(index: number): string | undefined {
    if (this.translated[index] !== undefined) return this.translated[index];
    const cached = this.cache.get(this.cacheKey(this.cues[index].text));
    if (cached !== undefined) {
      this.translated[index] = cached;
      return cached;
    }
    return undefined;
  }

  private textFor(index: number): string {
    const translation = this.translationFor(index);
    if (translation !== undefined) return translation;
    return this.cues[index].text; // graceful fallback until translated
  }

  /** How much of the track is translated, for a progress display. */
  public get progress(): { translated: number, total: number } {
    let done = 0;
    for (let i = 0; i < this.cues.length; i += 1) {
      if (this.translationFor(i) !== undefined) done += 1;
    }
    return { translated: done, total: this.cues.length };
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
        // When hiding untranslated cues, a pending one is simply not shown yet:
        // showing the source text and swapping it a moment later looks broken.
        const text = this.hideUntranslated ? this.translationFor(i) : this.textFor(i);
        if (text !== undefined) result.push({ start: cue.start, end: cue.end, text });
      }
    }
    return result;
  }

  private isCoolingDown(now: number): boolean {
    return this.disabledUntil > now;
  }

  private isInWindow(index: number, time: number): boolean {
    const cue = this.cues[index];
    return cue.end >= time - this.behind && cue.start <= time + this.lookahead;
  }

  private collectWindowIndices(time: number): number[] {
    const indices: number[] = [];
    for (let i = 0; i < this.cues.length; i += 1) {
      const settled = this.translated[i] !== undefined || this.pending[i];
      if (!settled && this.isInWindow(i, time)) {
        const cached = this.cache.get(this.cacheKey(this.cues[i].text));
        if (cached !== undefined) {
          this.translated[i] = cached;
        } else {
          indices.push(i);
        }
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

    const startedAt = this.generation;
    const options = { timeout: this.requestTimeout };

    this.translateFn(uniqueTexts, this.config, options)
      .then((results) => {
        // A result from a provider we have since replaced would be written under
        // the wrong cache namespace, so drop it and let the window reschedule.
        if (startedAt !== this.generation) return;
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
        if (startedAt !== this.generation) return;
        this.lastError = e;
        this.consecutiveFailures += 1;
        // Back off exponentially (capped) after repeated failures so a bad key or
        // offline endpoint does not spam requests every poll.
        if (this.consecutiveFailures >= 2) {
          const backoff = Math.min(30000, 1000 * (2 ** this.consecutiveFailures));
          this.disabledUntil = Date.now() + backoff;
        }
        // Do not retry auth/permission errors automatically: the credentials are
        // not going to fix themselves. Stop, then give the owner one chance to
        // hand us a different provider (in practice, a local Ollama).
        if (isAuthError(e)) {
          this.disabledUntil = Number.MAX_SAFE_INTEGER;
          this.tryAuthFailover();
        }
      })
      .finally(() => {
        indices.forEach((i) => { this.pending[i] = false; });
        this.activeBatches -= 1;
      });
  }

  /**
   * Ask the owner for a replacement provider after an auth rejection. Runs at
   * most once per translator: if the fallback also fails to authenticate we stop
   * for good rather than ping-pong between providers.
   */
  private tryAuthFailover(): void {
    if (this.authFailoverStarted || !this.onAuthFailure || this.disposed) return;
    this.authFailoverStarted = true;
    this.onAuthFailure()
      .then((failover) => {
        // dispose() may have won the race while we were resolving.
        if (!failover || this.disposed) return;
        this.generation += 1;
        this.config = failover.config;
        this.namespace = RealtimeSubtitleTranslator.namespaceFor(failover.config);
        this.requestTimeout = failover.requestTimeout;
        // Omitted means "keep the current window", not "reset to the default".
        if (failover.lookaheadSeconds !== undefined) this.lookahead = failover.lookaheadSeconds;
        this.consecutiveFailures = 0;
        this.lastError = undefined;
        this.disabledUntil = 0;
      })
      .catch(() => {
        // Keep the original auth error and stay disabled.
      });
  }

  public dispose(): void {
    this.disposed = true;
    this.disabledUntil = Number.MAX_SAFE_INTEGER;
  }
}
