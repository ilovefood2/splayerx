/**
 * OpenAI-compatible LLM translation client.
 *
 * Self-contained: depends only on the global `fetch` (available in the Electron
 * renderer and in modern Node). Given a batch of subtitle text lines it returns
 * their translations in the same order, preserving line breaks.
 *
 * Works with any endpoint exposing the OpenAI Chat Completions API shape, e.g.
 * OpenAI, Azure OpenAI (gateway), Groq, Ollama (`/v1`), OpenRouter, etc.
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
  let url = (baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(url)) return url;
  return `${url}/chat/completions`;
}

function buildSystemPrompt(config: AITranslatorConfig): string {
  const from = config.sourceLanguage ? `from ${config.sourceLanguage} ` : '';
  return [
    `You are a professional subtitle translator. Translate the given subtitle lines ${from}`,
    `into ${config.targetLanguage}.`,
    'Rules:',
    '- Return ONLY a JSON object of the form {"translations": ["...", "..."]}.',
    '- The "translations" array MUST have exactly the same number of items as the input, in the same order.',
    '- Translate meaning naturally and concisely, as spoken subtitles, not literally.',
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
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
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

  const json = await response.json().catch(() => undefined) as
    | { choices?: { message?: { content?: string } }[] }
    | undefined;
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new AITranslationError('Translation API returned an unexpected response shape');
  return content;
}

/**
 * Translate an array of subtitle text lines. Always resolves with an array of the
 * same length. On a recoverable formatting error it falls back to the original
 * lines rather than dropping subtitles; hard errors (network/auth) still throw.
 */
export async function translateLines(
  texts: string[],
  config: AITranslatorConfig,
  options: TranslateOptions = {},
): Promise<string[]> {
  if (!texts.length) return [];
  const endpoint = resolveEndpoint(config.baseUrl);
  const body = {
    model: config.model || DEFAULT_MODEL,
    temperature: config.temperature ?? DEFAULT_TEMPERATURE,
    messages: [
      { role: 'system', content: buildSystemPrompt(config) },
      { role: 'user', content: buildUserPayload(texts) },
    ],
  };
  const content = await requestCompletion(endpoint, body, config, options);
  const translations = parseTranslations(content, texts.length);
  // Fall back to originals when the model's output cannot be aligned, so playback
  // keeps showing something readable instead of blank cues.
  return translations ?? texts.slice();
}
