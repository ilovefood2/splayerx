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
  /**
   * Reports an individual result as soon as it is ready. Tower translates each
   * subtitle line separately, so callers should not have to wait for every line
   * in the surrounding batch before displaying the first completed ones.
   */
  onTranslation?: (index: number, text: string) => void;
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
function resolveEndpoint(baseUrl: string, responses = false): string {
  const url = (baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  if (responses && /\/responses$/.test(url)) return url;
  if (/\/chat\/completions$/.test(url)) return url;
  return `${url}/${responses ? 'responses' : 'chat/completions'}`;
}

/** Official GPT-5.x models use the Responses API. Keep other compatible
 * gateways on Chat Completions, which is still the most widely supported API. */
function usesResponsesAPI(config: AITranslatorConfig): boolean {
  const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).trim();
  return /^https:\/\/(api\.)?openai\.com\/v1(?:\/|$)/i.test(baseUrl)
    && /^gpt-5(?:[.-]|$)/i.test(config.model || '');
}

export function isTowerModel(model: string): boolean {
  return /tower-plus/i.test(model || '');
}

/** Sakura GalTransl is a Japanese-to-Simplified-Chinese specialist model. */
export function isSakuraModel(model: string): boolean {
  return /sakura-galtransl|galtransl/i.test(model || '');
}

function towerLanguageName(language: string): string {
  if (/^simplified chinese$/i.test(language)) return 'Chinese (Simplified)';
  if (/^traditional chinese$/i.test(language)) return 'Chinese (Traditional)';
  return language;
}

/** Use the single-source format recommended by Tower's authors. */
function buildTowerPrompt(text: string, config: AITranslatorConfig): string {
  const target = towerLanguageName(config.targetLanguage);
  const source = config.sourceLanguage
    ? towerLanguageName(config.sourceLanguage) : 'Source';
  const instruction = config.sourceLanguage
    ? `Translate the following ${source} source text to ${target}`
    : `Translate the following source text to ${target}`;
  return [
    `${instruction} as natural, concise spoken subtitles. Preserve casual tone, implied subjects,`,
    'and speaker intent; do not translate literally:',
    `${source}: ${text}`,
    `${target}: `,
  ].join('\n');
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

async function requestCompletion(
  endpoint: string,
  body: object,
  config: AITranslatorConfig,
  options: TranslateOptions,
): Promise<string> {
  const controller = new AbortController();
  // NOTE: explicit undefined checks rather than `??` throughout this module —
  // webpack 4 cannot parse `??`/`?.`, and ts-loader passes them through untouched
  // because tsconfig targets esnext. `||` is wrong here: it would discard a
  // deliberate 0 (e.g. temperature: 0).
  const timeout = options.timeout === undefined ? DEFAULT_TIMEOUT : options.timeout;
  const timer = setTimeout(() => controller.abort(), timeout);
  const abort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', abort, { once: true });
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
    if (options.signal) options.signal.removeEventListener('abort', abort);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new AITranslationError(
      `Translation API returned ${response.status} ${response.statusText}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
      response.status,
    );
  }

  const json = await response.json().catch(() => undefined) as
    | { choices?: { message?: { content?: string } }[], output_text?: string,
      output?: { content?: { text?: string }[] }[] }
    | undefined;
  if (json && typeof json.output_text === 'string') return json.output_text;
  if (json && Array.isArray(json.output)) {
    const output = json.output
      .reduce((all: string[], item) => all.concat((item.content || [])
        .map(part => part.text).filter((text): text is string => typeof text === 'string')), []);
    if (output.length) return output.join('');
  }
  const choices = json && json.choices;
  const first = choices && choices[0];
  const message = first && first.message;
  const content = message && message.content;
  if (typeof content !== 'string') throw new AITranslationError('Translation API returned an unexpected response shape');
  return content;
}

async function translateTowerLines(
  texts: string[],
  config: AITranslatorConfig,
  options: TranslateOptions,
): Promise<string[]> {
  const endpoint = resolveEndpoint(config.baseUrl);
  const translated = new Array<string>(texts.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < texts.length) {
      const index = nextIndex;
      nextIndex += 1;
      const content = await requestCompletion(endpoint, {
        model: config.model,
        temperature: 0,
        max_tokens: 512,
        messages: [{ role: 'user', content: buildTowerPrompt(texts[index], config) }],
      }, config, options);
      const text = content.trim();
      if (!text) throw new AITranslationError('Tower+ returned an empty translation');
      translated[index] = text;
      if (options.onTranslation) options.onTranslation(index, text);
    }
  };
  // Two in-flight lines keep local inference busy without flooding its queue.
  const workers = new Array(Math.min(2, texts.length)).fill(undefined).map(() => worker());
  await Promise.all(workers);
  return translated;
}

const SAKURA_HISTORY_LIMIT = 8;

/** The upstream Sakura GalTransl system prompt, with a subtitle-safe output rule. */
function buildSakuraSystemPrompt(): string {
  return [
    '你是一个视觉小说翻译模型，可以通顺地使用给定的术语表以指定的风格将日文翻译成简体中文，',
    '并联系上下文正确使用人称代词，注意不要混淆使役态和被动态的主语和宾语，',
    '不要擅自添加原文中没有的特殊符号，也不要擅自增加或减少换行。',
    '只输出译文，不要解释。',
  ].join('');
}

function buildSakuraPrompt(text: string, history: string[]): string {
  const sections: string[] = [];
  if (history.length) sections.push(`历史翻译：${history.join('\n')}`);
  sections.push('参考以下术语表（可为空，格式为src->dst #备注）：');
  sections.push('根据以上术语表的对应关系和备注，结合历史剧情和上下文，将下面的文本从日文翻译成简体中文：\n' + text);
  return sections.join('\n\n');
}

/**
 * Sakura emits natural translation text rather than this app's JSON batch
 * envelope. Translate one cue at a time and pass a bounded translated history
 * to retain the model's intended dialogue context.
 */
async function translateSakuraLines(
  texts: string[],
  config: AITranslatorConfig,
  options: TranslateOptions,
): Promise<string[]> {
  const endpoint = resolveEndpoint(config.baseUrl);
  const translated: string[] = [];
  const history: string[] = [];
  for (let index = 0; index < texts.length; index += 1) {
    const content = await requestCompletion(endpoint, {
      model: config.model,
      temperature: 0.3,
      top_p: 0.8,
      max_tokens: 512,
      messages: [
        { role: 'system', content: buildSakuraSystemPrompt() },
        { role: 'user', content: buildSakuraPrompt(texts[index], history) },
      ],
    }, config, options);
    const text = content.trim();
    if (!text) throw new AITranslationError('Sakura GalTransl returned an empty translation');
    translated.push(text);
    history.push(text);
    if (history.length > SAKURA_HISTORY_LIMIT) history.shift();
    if (options.onTranslation) options.onTranslation(index, text);
  }
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
  if (isTowerModel(config.model)) return translateTowerLines(texts, config, options);
  if (isSakuraModel(config.model)) return translateSakuraLines(texts, config, options);
  const responses = usesResponsesAPI(config);
  const endpoint = resolveEndpoint(config.baseUrl, responses);
  const body = responses
    ? {
      model: config.model || DEFAULT_MODEL,
      input: [
        { role: 'system', content: buildSystemPrompt(config) },
        { role: 'user', content: buildUserPayload(texts) },
      ],
    }
    : {
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
