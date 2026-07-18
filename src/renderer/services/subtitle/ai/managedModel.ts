/** SPlayer-owned selectable local translation-model runtime. */

import { ChildProcess, spawn } from 'child_process';
import { createHash } from 'crypto';
import {
  createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from 'fs';
import {
  createServer as createHTTPServer, IncomingMessage, Server as HTTPServer, ServerResponse,
} from 'http';
import { createServer } from 'net';
import { dirname, join } from 'path';

export interface ManagedModelDefinition {
  id: string;
  name: string;
  fileName: string;
  alias: string;
  sha256: string;
  url: string;
  downloadSize: string;
}

export const MANAGED_MODELS: ManagedModelDefinition[] = [
  {
    id: 'qwen3-14b',
    name: 'Qwen3 14B',
    fileName: 'Qwen3-14B-Q4_K_M.gguf',
    alias: 'splayer-qwen3-14b',
    sha256: '500a8806e85ee9c83f3ae08420295592451379b4f8cf2d0f41c15dffeb6b81f0',
    url: 'https://huggingface.co/Qwen/Qwen3-14B-GGUF/resolve/main/Qwen3-14B-Q4_K_M.gguf?download=true',
    downloadSize: '9 GB',
  },
  {
    id: 'qwen3-32b',
    name: 'Qwen3 32B',
    fileName: 'Qwen3-32B-Q4_K_M.gguf',
    alias: 'splayer-qwen3-32b',
    sha256: 'efd971561896866f0e910cce52761ca77b1b138090c7f15fe284676d57d1f689',
    url: 'https://huggingface.co/Qwen/Qwen3-32B-GGUF/resolve/main/Qwen3-32B-Q4_K_M.gguf?download=true',
    downloadSize: '20 GB',
  },
  {
    id: 'madlad400-10b-mt',
    name: 'MADLAD-400 10B-MT',
    fileName: 'model-q6_k.gguf',
    alias: 'splayer-madlad400-10b-mt',
    sha256: '1bae3de3d35a08c900de28c165e5f59cfe9a59a1b20e53d441caf36ce43cf169',
    url: [
      'https://huggingface.co/thirteenbit/madlad400-10b-mt-gguf/resolve/main/',
      'model-q6_k.gguf?download=true',
    ].join(''),
    downloadSize: '8.79 GB',
  },
];

export const DEFAULT_MANAGED_MODEL_ID = 'madlad400-10b-mt';

export function managedModelById(id?: string): ManagedModelDefinition {
  const selected = MANAGED_MODELS.find(model => model.id === id);
  const fallback = MANAGED_MODELS.find(model => model.id === DEFAULT_MANAGED_MODEL_ID);
  return (selected || fallback) as ManagedModelDefinition;
}

// Compatibility exports for callers that mean the default built-in model.
const DEFAULT_MANAGED_MODEL = managedModelById(DEFAULT_MANAGED_MODEL_ID);
export const MANAGED_MODEL_NAME = DEFAULT_MANAGED_MODEL.fileName;
export const MANAGED_MODEL_ALIAS = DEFAULT_MANAGED_MODEL.alias;
export const MANAGED_MODEL_SHA256 = DEFAULT_MANAGED_MODEL.sha256;
export const MANAGED_MODEL_URL = DEFAULT_MANAGED_MODEL.url;

export interface ManagedModelPaths {
  serverPath: string;
  modelDir: string;
}

export type ManagedModelStage = 'downloading' | 'verifying' | 'starting';

export interface ManagedModelProgress {
  stage: ManagedModelStage;
  received?: number;
  total?: number;
}

export interface ManagedModelStatus {
  runtimeAvailable: boolean;
  modelDownloaded: boolean;
  ready: boolean;
  modelPath: string;
}

export interface ManagedModelEndpoint {
  baseUrl: string;
  model: string;
}

export interface EnsureManagedModelOptions {
  paths: ManagedModelPaths;
  modelId?: string;
  onProgress?: (progress: ManagedModelProgress) => void;
  signal?: AbortSignal;
  startupTimeout?: number;
}

function markerPath(modelPath: string): string {
  return `${modelPath}.sha256`;
}

function markerMatches(modelPath: string, model: ManagedModelDefinition): boolean {
  const marker = markerPath(modelPath);
  if (!existsSync(modelPath) || !existsSync(marker)) return false;
  try {
    return readFileSync(marker, 'utf8').trim() === model.sha256;
  } catch (error) {
    return false;
  }
}

export function inspectManagedModel(
  paths: ManagedModelPaths,
  modelId?: string,
): ManagedModelStatus {
  const model = managedModelById(modelId);
  const modelPath = join(paths.modelDir, model.fileName);
  const runtimePath = model.id === 'madlad400-10b-mt'
    ? join(dirname(paths.serverPath), 'madlad-worker')
    : paths.serverPath;
  const runtimeAvailable = existsSync(runtimePath);
  const modelDownloaded = existsSync(modelPath);
  return {
    runtimeAvailable,
    modelDownloaded,
    ready: runtimeAvailable && modelDownloaded,
    modelPath,
  };
}

function removeIfPresent(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch (error) {
    // A later open/rename will report a useful error if cleanup really failed.
  }
}

/** Hash a model while reporting coarse progress so multi-gigabyte verification stays visible. */
export function sha256File(
  path: string,
  signal?: AbortSignal,
  onProgress?: (received: number, total: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const total = statSync(path).size;
    let received = 0;
    let lastPercent = -1;
    const input = createReadStream(path);
    const abort = () => input.destroy(new Error('aborted'));
    const report = () => {
      if (!onProgress) return;
      const percent = total > 0 ? Math.floor((received / total) * 100) : 100;
      if (percent === lastPercent) return;
      lastPercent = percent;
      onProgress(received, total);
    };
    report();
    if (signal) {
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
    }
    input.on('data', (chunk: Buffer) => {
      hash.update(chunk);
      received += chunk.length;
      report();
    });
    input.on('error', reject);
    input.on('end', () => resolve(hash.digest('hex')));
    input.on('close', () => {
      if (signal) signal.removeEventListener('abort', abort);
    });
  });
}

/** Total file size from an HTTP Content-Range header. Exported for tests. */
export function contentRangeTotal(value?: string): number {
  if (!value) return 0;
  const match = /\/(\d+)$/.exec(value);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Download into a persistent `.part` file. A server that honours Range resumes
 * it; a server that returns 200 safely restarts it instead of appending garbage.
 */
function fetchResumable(
  url: string,
  part: string,
  onProgress?: (received: number, total: number) => void,
  signal?: AbortSignal,
  redirects = 0,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(new Error('aborted')); return; }
    const current = existsSync(part) ? statSync(part).size : 0;
    // eslint-disable-next-line global-require
    const https = require('https');
    const request = https.get(url, {
      headers: current > 0 ? { Range: `bytes=${current}-` } : {},
    }, (res: IncomingMessage) => {
      const status = res.statusCode as number;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location) {
        res.resume();
        if (redirects >= 5) { reject(new Error('too many redirects')); return; }
        const next = new URL(location, url).toString();
        fetchResumable(next, part, onProgress, signal, redirects + 1).then(resolve, reject);
        return;
      }
      // A complete partial file can legitimately receive 416. Let checksum
      // verification decide whether it is the finished model.
      if (status === 416 && current > 0) {
        res.resume();
        resolve();
        return;
      }
      if (status !== 200 && status !== 206) {
        res.resume();
        reject(new Error(`model download failed: HTTP ${status}`));
        return;
      }
      const resumed = status === 206 && current > 0;
      const initial = resumed ? current : 0;
      const rangedTotal = contentRangeTotal(res.headers['content-range']);
      const contentLength = parseInt(res.headers['content-length'] || '0', 10);
      const total = rangedTotal || (contentLength > 0 ? initial + contentLength : 0);
      let received = initial;
      const output = createWriteStream(part, { flags: resumed ? 'a' : 'w' });
      res.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (onProgress) onProgress(received, total);
      });
      res.on('error', reject);
      output.on('error', reject);
      output.on('finish', resolve);
      res.pipe(output);
    });
    request.on('error', reject);
    if (signal) {
      signal.addEventListener('abort', () => request.destroy(new Error('aborted')), { once: true });
    }
  });
}

export async function ensureManagedModelFile(
  paths: ManagedModelPaths,
  onProgress?: (progress: ManagedModelProgress) => void,
  signal?: AbortSignal,
  modelId?: string,
): Promise<string> {
  mkdirSync(paths.modelDir, { recursive: true });
  const model = managedModelById(modelId);
  const modelPath = join(paths.modelDir, model.fileName);
  if (markerMatches(modelPath, model)) return modelPath;

  // A complete file without a marker may have come from an older build. Verify
  // it once before deciding whether it needs to be downloaded again.
  if (existsSync(modelPath)) {
    const digest = await sha256File(
      modelPath,
      signal,
      onProgress
        ? (received, total) => onProgress({ stage: 'verifying', received, total })
        : undefined,
    );
    if (digest === model.sha256) {
      writeFileSync(markerPath(modelPath), `${model.sha256}\n`);
      return modelPath;
    }
    removeIfPresent(modelPath);
  }

  const part = `${modelPath}.part`;
  if (onProgress) {
    const received = existsSync(part) ? statSync(part).size : 0;
    onProgress({ stage: 'downloading', received, total: 0 });
  }
  await fetchResumable(
    model.url,
    part,
    onProgress ? (received, total) => onProgress({ stage: 'downloading', received, total }) : undefined,
    signal,
  );
  const digest = await sha256File(
    part,
    signal,
    onProgress
      ? (received, total) => onProgress({ stage: 'verifying', received, total })
      : undefined,
  );
  if (digest !== model.sha256) {
    removeIfPresent(part);
    throw new Error(`Translation model checksum mismatch: ${digest}`);
  }
  renameSync(part, modelPath);
  writeFileSync(markerPath(modelPath), `${model.sha256}\n`);
  return modelPath;
}

let serverChild: ChildProcess | undefined;
let serverEndpoint: ManagedModelEndpoint | undefined;
let serverPromise: Promise<ManagedModelEndpoint> | undefined;
let serverModelId: string | undefined;
let serverPromiseModelId: string | undefined;
let madladProxy: HTTPServer | undefined;
let madladRequestId = 0;
const madladResponses = new Map<string, ServerResponse>();

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(error => (error ? reject(error) : resolve(port)));
    });
  });
}

function healthReady(baseUrl: string): Promise<boolean> {
  const request = fetch(`${baseUrl.replace(/\/v1$/, '')}/health`)
    .then(response => response.ok)
    .catch(() => false);
  return Promise.race([
    request,
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1000)),
  ]);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sendJSON(response: ServerResponse, status: number, body: object): void {
  if (response.finished) return;
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(body));
}

function failMadladResponses(message: string): void {
  madladResponses.forEach(response => sendJSON(response, 500, { error: message }));
  madladResponses.clear();
}

function handleMadladRequest(
  request: IncomingMessage,
  response: ServerResponse,
  child: ChildProcess,
): void {
  if (request.method === 'GET' && request.url === '/health') {
    sendJSON(response, 200, { status: 'ok' });
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/completions') {
    sendJSON(response, 404, { error: 'not found' });
    return;
  }
  let body = '';
  request.on('data', (chunk: Buffer) => {
    body += chunk.toString();
    if (body.length > 1024 * 1024) request.destroy(new Error('request is too large'));
  });
  request.on('error', error => sendJSON(response, 400, { error: error.message }));
  request.on('end', () => {
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed.prompt !== 'string') throw new Error('prompt must be a string');
      madladRequestId += 1;
      const id = String(madladRequestId);
      madladResponses.set(id, response);
      response.on('close', () => madladResponses.delete(id));
      if (!child.stdin) throw new Error('MADLAD runtime input is unavailable');
      child.stdin.write(`${JSON.stringify({
        id,
        prompt: parsed.prompt,
        maxTokens: parsed.max_tokens,
      })}\n`);
    } catch (error) {
      sendJSON(response, 400, { error: (error as Error).message });
    }
  });
}

async function startMadladServer(
  paths: ManagedModelPaths,
  modelPath: string,
  model: ManagedModelDefinition,
  timeout: number,
  signal?: AbortSignal,
): Promise<ManagedModelEndpoint> {
  const workerPath = join(dirname(paths.serverPath), 'madlad-worker');
  if (!existsSync(workerPath)) throw new Error('bundled MADLAD runtime is missing');
  const port = await freeLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  let stderr = '';
  let stdout = '';
  let startupSettled = false;
  let resolveReady: () => void;
  let rejectReady: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const child = spawn(workerPath, [modelPath], {
    env: Object.assign({}, process.env, { DYLD_LIBRARY_PATH: dirname(workerPath) }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  serverChild = child;
  if (!child.stderr || !child.stdout) throw new Error('MADLAD runtime streams are unavailable');
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-6000); });
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    let newline = stdout.indexOf('\n');
    while (newline >= 0) {
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (line) {
        try {
          const message = JSON.parse(line);
          if (message.ready && !startupSettled) {
            startupSettled = true;
            resolveReady();
          } else if (message.id) {
            const response = madladResponses.get(String(message.id));
            madladResponses.delete(String(message.id));
            if (response) {
              if (message.error) {
                sendJSON(response, 500, { error: message.error });
              } else {
                sendJSON(response, 200, {
                  choices: [{ text: message.text || '' }], model: model.alias,
                });
              }
            }
          }
        } catch (error) {
          stderr = `${stderr}\ninvalid MADLAD response: ${line}`.slice(-6000);
        }
      }
      newline = stdout.indexOf('\n');
    }
  });
  child.on('error', (error: Error) => {
    if (!startupSettled) {
      startupSettled = true;
      rejectReady(error);
    }
  });
  child.on('close', () => {
    if (!startupSettled) {
      startupSettled = true;
      rejectReady(new Error(`MADLAD runtime exited: ${stderr.slice(-500)}`));
    }
    failMadladResponses('MADLAD runtime stopped');
    if (madladProxy) madladProxy.close();
    madladProxy = undefined;
    if (serverChild === child) {
      serverChild = undefined;
      serverEndpoint = undefined;
      serverModelId = undefined;
    }
  });
  const abort = () => child.kill();
  if (signal) {
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ready,
      new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(
          `MADLAD runtime did not become ready: ${stderr.slice(-500)}`,
        )), timeout);
      }),
    ]);
    if (signal && signal.aborted) throw new Error('aborted');
    const proxy = createHTTPServer((request, response) => {
      handleMadladRequest(request, response, child);
    });
    madladProxy = proxy;
    await new Promise<void>((resolve, reject) => {
      proxy.once('error', reject);
      proxy.listen(port, '127.0.0.1', resolve);
    });
    if (signal) signal.removeEventListener('abort', abort);
    return { baseUrl, model: model.alias };
  } catch (error) {
    child.kill();
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function startManagedServer(
  paths: ManagedModelPaths,
  modelPath: string,
  model: ManagedModelDefinition,
  timeout: number,
  signal?: AbortSignal,
): Promise<ManagedModelEndpoint> {
  if (model.id === 'madlad400-10b-mt') {
    return startMadladServer(paths, modelPath, model, timeout, signal);
  }
  if (!existsSync(paths.serverPath)) throw new Error('bundled llama-server is missing');
  const port = await freeLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const args = [
    '-m', modelPath,
    '--alias', model.alias,
    '--host', '127.0.0.1',
    '--port', String(port),
    '--ctx-size', '4096',
    '--gpu-layers', '99',
    '--jinja',
    '--reasoning', 'off',
    '--no-webui',
  ];
  let stderr = '';
  const child = spawn(paths.serverPath, args, {
    env: Object.assign({}, process.env, { DYLD_LIBRARY_PATH: dirname(paths.serverPath) }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  serverChild = child;
  let spawnError = '';
  child.on('error', (error: Error) => { spawnError = error.message; });
  child.stderr!.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-6000); });
  child.on('close', () => {
    if (serverChild === child) {
      serverChild = undefined;
      serverEndpoint = undefined;
      serverModelId = undefined;
    }
  });
  const abort = () => child.kill();
  if (signal) {
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  }
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (signal && signal.aborted) throw new Error('aborted');
    if (spawnError) throw new Error(`could not start llama-server: ${spawnError}`);
    if (child.exitCode !== null) throw new Error(`llama-server exited: ${stderr.slice(-500)}`);
    if (await healthReady(baseUrl)) {
      if (signal) signal.removeEventListener('abort', abort);
      return { baseUrl, model: model.alias };
    }
    await delay(250);
  }
  child.kill();
  throw new Error(`llama-server did not become ready: ${stderr.slice(-500)}`);
}

export async function ensureManagedModelServer(
  options: EnsureManagedModelOptions,
): Promise<ManagedModelEndpoint> {
  const model = managedModelById(options.modelId);
  if (serverChild && serverEndpoint && serverChild.exitCode === null
    && serverModelId === model.id) return serverEndpoint;
  if (serverPromise) {
    if (serverPromiseModelId === model.id) return serverPromise;
    try { await serverPromise; } catch (error) { /* Start the newly selected model below. */ }
    stopManagedModelServer();
  }
  if (serverChild && serverChild.exitCode === null && serverModelId !== model.id) {
    stopManagedModelServer();
  }
  const timeout = options.startupTimeout === undefined ? 120000 : options.startupTimeout;
  const pending = (async () => {
    const modelPath = await ensureManagedModelFile(
      options.paths, options.onProgress, options.signal, model.id,
    );
    if (options.onProgress) options.onProgress({ stage: 'starting' });
    const endpoint = await startManagedServer(
      options.paths, modelPath, model, timeout, options.signal,
    );
    serverEndpoint = endpoint;
    serverModelId = model.id;
    return endpoint;
  })();
  serverPromise = pending;
  serverPromiseModelId = model.id;
  try {
    return await pending;
  } finally {
    if (serverPromise === pending) {
      serverPromise = undefined;
      serverPromiseModelId = undefined;
    }
  }
}

export function stopManagedModelServer(): void {
  if (madladProxy) madladProxy.close();
  madladProxy = undefined;
  failMadladResponses('MADLAD runtime stopped');
  if (serverChild && serverChild.exitCode === null) serverChild.kill();
  serverChild = undefined;
  serverEndpoint = undefined;
  serverModelId = undefined;
  serverPromise = undefined;
  serverPromiseModelId = undefined;
}
