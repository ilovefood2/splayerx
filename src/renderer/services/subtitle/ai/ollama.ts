/**
 * Local Ollama detection and chat-model selection.
 *
 * Lets the AI subtitle translator work with no API key at all: if the user has
 * Ollama running we talk to it through its OpenAI-compatible `/v1` API, so
 * `translator.ts` needs no special case.
 *
 * Self-contained: depends only on the global `fetch`. Never throws and never
 * hangs — every failure is reported as a reason code so the caller can explain
 * itself to the user.
 *
 * NOTE: explicit `=== undefined` checks rather than `??`/`?.` throughout this
 * module. webpack 4 (acorn 6) cannot parse that syntax and ts-loader passes it
 * through untouched because tsconfig targets esnext.
 */

/** 127.0.0.1 rather than localhost: some hosts resolve ::1 first, Ollama binds v4. */
export const OLLAMA_DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1';

const DEFAULT_PROBE_TIMEOUT = 1500;

export interface OllamaModel {
  id: string;
  family?: string;
  capabilities?: string[];
  /** Parsed from the `parameter_size` string, in billions. */
  parameterBillions?: number;
  /** Emits reasoning tokens before answering — much slower for translation. */
  thinking: boolean;
  chatCapable: boolean;
}

export type OllamaProbeReason = 'ok' | 'unreachable' | 'no-chat-model';

export interface OllamaProbe {
  reachable: boolean;
  /** reachable AND at least one chat-capable model is installed. */
  available: boolean;
  baseUrl: string;
  /** Every model, including embedding-only ones (the UI explains exclusions). */
  models: OllamaModel[];
  /** Chat-capable models only, best-first. */
  chatModels: OllamaModel[];
  recommended?: string;
  reason: OllamaProbeReason;
  detail?: string;
  /** True when we fell back to `/v1/models`, which cannot report capabilities. */
  degraded: boolean;
}

/** `http://h:11434/v1` or `.../v1/chat/completions` -> `http://h:11434`. */
export function apiRootOf(baseUrl?: string): string {
  const raw = baseUrl === undefined || baseUrl === null ? '' : baseUrl;
  let url = raw.trim().replace(/\/+$/, '');
  if (!url) url = 'http://127.0.0.1:11434';
  url = url.replace(/\/chat\/completions$/, '');
  url = url.replace(/\/v1$/, '');
  return url.replace(/\/+$/, '');
}

/** Ollama reports `parameter_size` as a suffixed string: '14.8B', '566.70M'. */
export function parseParameterSize(raw?: string): number | undefined {
  if (!raw) return undefined;
  const matched = /^\s*([\d.]+)\s*([KMB]?)/i.exec(raw);
  if (!matched) return undefined;
  const value = parseFloat(matched[1]);
  if (Number.isNaN(value)) return undefined;
  const unit = matched[2].toUpperCase();
  if (unit === 'K') return value / 1e6;
  if (unit === 'M') return value / 1e3;
  return value;
}

const EMBEDDING_FAMILIES = ['bert', 'nomic-bert', 'xlm-roberta'];
const EMBEDDING_NAME = /(^|[-_/])(bge|gte|e5|embed|embedding|all-minilm|paraphrase|arctic-embed)/i;

/**
 * An embedding model cannot chat. bge-m3 is the common case: it reports
 * `capabilities: ['embedding']` and `family: 'bert'`.
 */
export function isEmbeddingModel(model: {
  id: string, family?: string, capabilities?: string[],
}): boolean {
  const caps = model.capabilities;
  if (caps && caps.length) {
    // Authoritative when present: trust it and do not second-guess by name.
    if (caps.indexOf('embedding') !== -1) return true;
    if (caps.indexOf('completion') !== -1) return false;
  }
  const family = model.family ? model.family.toLowerCase() : '';
  if (family && EMBEDDING_FAMILIES.indexOf(family) !== -1) return true;
  return EMBEDDING_NAME.test(model.id);
}

/** Models whose ids imply reasoning, used only when capabilities are unavailable. */
const THINKING_NAME = /(^|[-_/])(qwq|r1|deepseek-r1|reasoner|thinking)/i;
const QWEN3_THINKING = /^qwen3(:|-\d|$)/i;
const CODER_NAME = /(coder|code)/i;

function scoreOf(model: OllamaModel): number {
  let score = 100;
  // Measured on this repo's own prompt: a thinking model spends 20-30s per
  // 16-line batch on reasoning tokens, versus ~5s for a non-thinking model of
  // twice the size. Latency dominates everything else for realtime subtitles.
  if (model.thinking) score -= 60;
  // Coder-tuned models translate fine but a general model is a better default.
  if (CODER_NAME.test(model.id)) score -= 5;
  const params = model.parameterBillions;
  if (params !== undefined) {
    // Mild preference for a larger model, but never enough to outweigh thinking.
    if (params >= 7) score += 4;
    if (params >= 27) score += 2;
    if (params < 2) score -= 6;
  }
  return score;
}

/** Best chat model for subtitle translation, or undefined if there is none. */
export function pickChatModel(models: OllamaModel[]): string | undefined {
  const candidates = models.filter(model => model.chatCapable);
  if (!candidates.length) return undefined;
  const ranked = candidates.slice().sort((a, b) => {
    const diff = scoreOf(b) - scoreOf(a);
    // Deterministic tiebreak so the pick never depends on map ordering.
    if (diff !== 0) return diff;
    return a.id < b.id ? -1 : 1;
  });
  return ranked[0].id;
}

interface RawModel {
  id: string;
  family?: string;
  capabilities?: string[];
  parameterSize?: string;
}

/** Shape of Ollama's `/api/tags` response (snake_case is theirs, not ours). */
interface OllamaTagsResponse {
  models?: {
    name?: string,
    model?: string,
    capabilities?: string[],
    details?: {
      family?: string,
      // eslint-disable-next-line camelcase
      parameter_size?: string,
    },
  }[];
}

function toModel(raw: RawModel): OllamaModel {
  const caps = raw.capabilities;
  const hasCaps = !!(caps && caps.length);
  const thinking = hasCaps
    ? (caps as string[]).indexOf('thinking') !== -1
    : (THINKING_NAME.test(raw.id) || QWEN3_THINKING.test(raw.id));
  const model: OllamaModel = {
    id: raw.id,
    family: raw.family,
    capabilities: caps,
    parameterBillions: parseParameterSize(raw.parameterSize),
    thinking,
    chatCapable: false,
  };
  model.chatCapable = !isEmbeddingModel(model);
  return model;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  // The unit-test fetch mock ignores AbortSignal, and a wedged socket would
  // otherwise stall subtitle setup, so race rather than rely on abort alone.
  return Promise.race([
    promise,
    new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), ms)),
  ]);
}

function unreachable(baseUrl: string, detail?: string): OllamaProbe {
  return {
    reachable: false,
    available: false,
    baseUrl,
    models: [],
    chatModels: [],
    reason: 'unreachable',
    detail,
    degraded: false,
  };
}

async function getJson(url: string, timeout: number): Promise<object | undefined> {
  const request = fetch(url, { method: 'GET' })
    .then(async (response) => {
      if (!response.ok) return undefined;
      return response.json().catch(() => undefined);
    })
    .catch(() => undefined);
  return withTimeout(request, timeout) as Promise<object | undefined>;
}

/**
 * Ask a local Ollama what it has installed.
 *
 * Prefers `/api/tags`, the only endpoint that reports capabilities — without it
 * an embedding model such as bge-m3 is indistinguishable from a chat model.
 * Falls back to the OpenAI-shaped `/v1/models` (marked `degraded`) so older
 * Ollama builds still work.
 */
export async function probeOllama(
  baseUrl?: string,
  options: { timeout?: number } = {},
): Promise<OllamaProbe> {
  const timeout = options.timeout === undefined ? DEFAULT_PROBE_TIMEOUT : options.timeout;
  const root = apiRootOf(baseUrl);
  const resolvedBaseUrl = `${root}/v1`;

  let degraded = false;
  let raws: RawModel[] = [];

  const tags = await getJson(`${root}/api/tags`, timeout) as OllamaTagsResponse | undefined;

  if (tags && tags.models) {
    raws = tags.models.map((entry) => {
      const details = entry.details;
      const id = entry.name || entry.model || '';
      return {
        id,
        family: details ? details.family : undefined,
        capabilities: entry.capabilities,
        // eslint-disable-next-line camelcase
        parameterSize: details ? details.parameter_size : undefined,
      };
    }).filter(entry => !!entry.id);
  } else {
    const models = await getJson(`${resolvedBaseUrl}/models`, timeout) as
      | { data?: { id?: string }[] }
      | undefined;
    if (!models || !models.data) return unreachable(resolvedBaseUrl, 'no response from /api/tags or /v1/models');
    degraded = true;
    raws = models.data.map(entry => ({ id: entry.id || '' })).filter(entry => !!entry.id);
  }

  const all = raws.map(toModel);
  const chatModels = all.filter(model => model.chatCapable);
  const recommended = pickChatModel(all);
  if (!chatModels.length) {
    return {
      reachable: true,
      available: false,
      baseUrl: resolvedBaseUrl,
      models: all,
      chatModels,
      reason: 'no-chat-model',
      degraded,
    };
  }
  return {
    reachable: true,
    available: true,
    baseUrl: resolvedBaseUrl,
    models: all,
    chatModels,
    recommended,
    reason: 'ok',
    degraded,
  };
}
