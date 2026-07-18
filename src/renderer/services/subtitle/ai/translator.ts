/**
 * OpenAI-compatible LLM translation client.
 *
 * Self-contained: depends only on the global `fetch` (available in the Electron
 * renderer and in modern Node). Given a batch of subtitle text lines it returns
 * their translations in the same order, preserving line breaks.
 *
 * Works with any endpoint exposing the OpenAI Chat Completions API shape, e.g.
 * SPlayer's bundled llama.cpp server, OpenAI, Azure OpenAI gateways, Groq,
 * OpenRouter, and other compatible services.
 */

export interface AITranslatorConfig {
  /** Base URL of an OpenAI-compatible API, e.g. `https://api.openai.com/v1`. */
  baseUrl: string;
  /** Bearer token. May be empty for local gateways that do not require auth. */
  apiKey: string;
  /** Chat model id, e.g. `gpt-4o-mini`. */
  model: string;
  /** Human-readable target language name, e.g. `Simplified Chinese`. */
  targetLanguage: string;
  /** BCP-47 target code used by dedicated translation models, e.g. `zh-CN`. */
  targetLanguageCode?: string;
  /** Optional human-readable source language name. Auto-detected when omitted. */
  sourceLanguage?: string;
  /** Sampling temperature. Defaults to a low value for deterministic output. */
  temperature?: number;
}

export interface TranslateOptions {
  /** Abort the in-flight request. */
  signal?: AbortSignal;
  /** Per-request timeout in milliseconds. Defaults to 30000. */
  timeout?: number;
}

export const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TIMEOUT = 30000;
const DEFAULT_TEMPERATURE = 0.2;

export class AITranslationError extends Error {
  public readonly status?: number;

  public constructor(message: string, status?: number) {
    super(message);
    this.name = 'AITranslationError';
    this.status = status;
  }
}

/** Trim trailing slashes and a trailing `/chat/completions` if the user pasted a full URL. */
function resolveEndpoint(baseUrl: string): string {
  const url = (baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(url)) return url;
  return `${url}/chat/completions`;
}

function resolveCompletionsEndpoint(baseUrl: string): string {
  const url = (baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  if (/\/completions$/.test(url)) return url;
  return `${url}/completions`;
}

export function isMadladModel(model: string): boolean {
  return /madlad400/i.test(model || '');
}

/** MADLAD uses a target-language token instead of a chat instruction. */
export function madladTargetToken(code?: string, languageName?: string): string {
  const aliases: Record<string, string> = {
    'zh-cn': 'zh',
    'zh-hans': 'zh',
    'zh-tw': 'zh_Hant',
    'zh-hant': 'zh_Hant',
    nb: 'no',
  };
  const raw = (code || '').trim();
  let normalized = aliases[raw.toLowerCase()] || raw.replace('-', '_');
  if (!normalized) {
    const name = (languageName || '').toLowerCase();
    if (name.indexOf('traditional chinese') >= 0) normalized = 'zh_Hant';
    else if (name.indexOf('chinese') >= 0) normalized = 'zh';
  }
  if (!/^[A-Za-z]{2,3}(?:_[A-Za-z]{4})?$/.test(normalized)) {
    throw new AITranslationError(`MADLAD does not recognise target language: ${languageName || code || ''}`);
  }
  return `<2${normalized}>`;
}

function buildSystemPrompt(config: AITranslatorConfig): string {
  const from = config.sourceLanguage ? `from ${config.sourceLanguage} ` : '';
  return [
    `You are a professional subtitle translator. Translate the given subtitle lines ${from}`,
    `into ${config.targetLanguage}.`,
    'Rules:',
    '- Return ONLY a JSON object of the form {"translations": ["...", "..."]}.',
    '- The "translations" array MUST have exactly the same number of items as the input, in the same order.',
    '- Use the whole batch as context to resolve pronouns, slang, tone and ambiguous wording.',
    '- Translate meaning completely, naturally and concisely, as spoken subtitles, not literally.',
    '- Preserve the speaker intent, register, humour, terminology and proper names consistently.',
    '- Preserve line breaks (\\n) inside a single line when present.',
    '- Do NOT add commentary, numbering, romanization or quotes around the text.',
    '- If a line is already in the target language or is untranslatable (e.g. a name), keep it as-is.',
  ].join(' ');
}

function buildUserPayload(texts: string[]): string {
  // Feed the lines as a JSON array so the model can align input/output unambiguously.
  return JSON.stringify({ lines: texts });
}

/** Best-effort extraction of the translations array from an arbitrary model reply. */
function parseTranslations(content: string, expectedLength: number): string[] | undefined {
  const attempts: string[] = [content];
  // The model may wrap JSON in a ```json fence or add stray prose.
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) attempts.unshift(fenced[1]);
  const braceMatch = content.match(/\{[\s\S]*\}/);
  if (braceMatch) attempts.push(braceMatch[0]);
  const bracketMatch = content.match(/\[[\s\S]*\]/);
  if (bracketMatch) attempts.push(bracketMatch[0]);

  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate.trim());
      const arr = Array.isArray(parsed) ? parsed : parsed.translations;
      if (Array.isArray(arr) && arr.length === expectedLength) {
        return arr.map(item => (typeof item === 'string' ? item : String(item)));
      }
    } catch (e) {
      // try the next candidate
    }
  }
  return undefined;
}

async function requestJSON(
  endpoint: string,
  body: object,
  config: AITranslatorConfig,
  options: TranslateOptions,
): Promise<unknown> {
  const controller = new AbortController();
  // NOTE: explicit undefined checks rather than `??` throughout this module —
  // webpack 4 cannot parse `??`/`?.`, and ts-loader passes them through untouched
  // because tsconfig targets esnext. `||` is wrong here: it would discard a
  // deliberate 0 (e.g. temperature: 0).
  const timeout = options.timeout === undefined ? DEFAULT_TIMEOUT : options.timeout;
  const timer = setTimeout(() => controller.abort(), timeout);
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError') throw new AITranslationError(`Translation request timed out after ${timeout}ms`);
    throw new AITranslationError(`Translation request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new AITranslationError(
      `Translation API returned ${response.status} ${response.statusText}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
      response.status,
    );
  }

  return response.json().catch(() => undefined);
}

async function requestCompletion(
  endpoint: string,
  body: object,
  config: AITranslatorConfig,
  options: TranslateOptions,
): Promise<string> {
  const json = await requestJSON(endpoint, body, config, options) as
    | { choices?: { message?: { content?: string } }[] }
    | undefined;
  const choices = json && json.choices;
  const first = choices && choices[0];
  const message = first && first.message;
  const content = message && message.content;
  if (typeof content !== 'string') throw new AITranslationError('Translation API returned an unexpected response shape');
  return content;
}

async function requestTextCompletion(
  endpoint: string,
  body: object,
  config: AITranslatorConfig,
  options: TranslateOptions,
): Promise<string> {
  const json = await requestJSON(endpoint, body, config, options) as
    | { choices?: { text?: string }[] }
    | undefined;
  const choices = json && json.choices;
  const first = choices && choices[0];
  const text = first && first.text;
  if (typeof text !== 'string') {
    throw new AITranslationError('MADLAD returned an unexpected response shape');
  }
  return text.trim();
}

async function translateMadladLines(
  texts: string[],
  config: AITranslatorConfig,
  options: TranslateOptions,
): Promise<string[]> {
  const endpoint = resolveCompletionsEndpoint(config.baseUrl);
  const targetToken = madladTargetToken(config.targetLanguageCode, config.targetLanguage);
  const translated = new Array<string>(texts.length);
  let nextIndex = 0;
  // The dedicated encoder-decoder runtime handles one request at a time while
  // keeping the large model resident in memory between subtitle lines.
  const worker = async () => {
    while (nextIndex < texts.length) {
      const index = nextIndex;
      nextIndex += 1;
      const text = await requestTextCompletion(endpoint, {
        model: config.model,
        prompt: `${targetToken} ${texts[index]}`,
        temperature: 0,
        max_tokens: 512,
      }, config, options);
      if (!text) throw new AITranslationError('MADLAD returned an empty translation');
      translated[index] = text;
    }
  };
  const workers = new Array(Math.min(1, texts.length)).fill(undefined).map(() => worker());
  await Promise.all(workers);
  return translated;
}

/**
 * Translate an array of subtitle text lines, resolving with an array of the same
 * length and order.
 *
 * Throws `AITranslationError` when the reply cannot be aligned to the input, so
 * the caller can retry it like any other failure. It deliberately does NOT fall
 * back to returning the source lines: to a caller that is indistinguishable from
 * a successful translation, so the untranslated text gets cached and shown
 * forever. Callers keep subtitles readable by displaying the source text while a
 * translation is missing (see `RealtimeSubtitleTranslator`).
 */
export async function translateLines(
  texts: string[],
  config: AITranslatorConfig,
  options: TranslateOptions = {},
): Promise<string[]> {
  if (!texts.length) return [];
  if (isMadladModel(config.model)) return translateMadladLines(texts, config, options);
  const endpoint = resolveEndpoint(config.baseUrl);
  const body = {
    model: config.model || DEFAULT_MODEL,
    temperature: config.temperature === undefined ? DEFAULT_TEMPERATURE : config.temperature,
    messages: [
      { role: 'system', content: buildSystemPrompt(config) },
      { role: 'user', content: buildUserPayload(texts) },
    ],
  };
  const content = await requestCompletion(endpoint, body, config, options);
  const translations = parseTranslations(content, texts.length);
  if (!translations) {
    throw new AITranslationError(
      `Translation API returned ${texts.length} line(s) worth of input but a reply that could not be aligned to it`,
    );
  }
  return translations;
}
