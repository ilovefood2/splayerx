/**
 * SPlayer-owned Qwen3 runtime.
 *
 * The application ships llama-server, downloads the official quantized Qwen3
 * model on first use, verifies its SHA-256, and starts a private loopback API.
 * No Ollama installation or background service is required.
 */

import { ChildProcess, spawn } from 'child_process';
import { createHash } from 'crypto';
import {
  createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from 'fs';
import { IncomingMessage } from 'http';
import { createServer } from 'net';
import { dirname, join } from 'path';

export const MANAGED_MODEL_NAME = 'Qwen3-4B-Q4_K_M.gguf';
export const MANAGED_MODEL_ALIAS = 'splayer-qwen3';
export const MANAGED_MODEL_SHA256 = '7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5';
export const MANAGED_MODEL_URL = [
  'https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/',
  'Qwen3-4B-Q4_K_M.gguf?download=true',
].join('');

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
  onProgress?: (progress: ManagedModelProgress) => void;
  signal?: AbortSignal;
  startupTimeout?: number;
}

function markerPath(modelPath: string): string {
  return `${modelPath}.sha256`;
}

function markerMatches(modelPath: string): boolean {
  const marker = markerPath(modelPath);
  if (!existsSync(modelPath) || !existsSync(marker)) return false;
  try {
    return readFileSync(marker, 'utf8').trim() === MANAGED_MODEL_SHA256;
  } catch (error) {
    return false;
  }
}

export function inspectManagedModel(paths: ManagedModelPaths): ManagedModelStatus {
  const modelPath = join(paths.modelDir, MANAGED_MODEL_NAME);
  const runtimeAvailable = existsSync(paths.serverPath);
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

function sha256(path: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const input = createReadStream(path);
    const abort = () => input.destroy(new Error('aborted'));
    if (signal) {
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
    }
    input.on('data', chunk => hash.update(chunk));
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
): Promise<string> {
  mkdirSync(paths.modelDir, { recursive: true });
  const modelPath = join(paths.modelDir, MANAGED_MODEL_NAME);
  if (markerMatches(modelPath)) return modelPath;

  // A complete file without a marker may have come from an older build. Verify
  // it once before deciding whether it needs to be downloaded again.
  if (existsSync(modelPath)) {
    if (onProgress) onProgress({ stage: 'verifying' });
    if (await sha256(modelPath, signal) === MANAGED_MODEL_SHA256) {
      writeFileSync(markerPath(modelPath), `${MANAGED_MODEL_SHA256}\n`);
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
    MANAGED_MODEL_URL,
    part,
    onProgress ? (received, total) => onProgress({ stage: 'downloading', received, total }) : undefined,
    signal,
  );
  if (onProgress) onProgress({ stage: 'verifying' });
  const digest = await sha256(part, signal);
  if (digest !== MANAGED_MODEL_SHA256) {
    removeIfPresent(part);
    throw new Error(`Qwen3 model checksum mismatch: ${digest}`);
  }
  renameSync(part, modelPath);
  writeFileSync(markerPath(modelPath), `${MANAGED_MODEL_SHA256}\n`);
  return modelPath;
}

let serverChild: ChildProcess | undefined;
let serverEndpoint: ManagedModelEndpoint | undefined;
let serverPromise: Promise<ManagedModelEndpoint> | undefined;

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

async function startManagedServer(
  paths: ManagedModelPaths,
  modelPath: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<ManagedModelEndpoint> {
  if (!existsSync(paths.serverPath)) throw new Error('bundled llama-server is missing');
  const port = await freeLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const args = [
    '-m', modelPath,
    '--alias', MANAGED_MODEL_ALIAS,
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
      return { baseUrl, model: MANAGED_MODEL_ALIAS };
    }
    await delay(250);
  }
  child.kill();
  throw new Error(`llama-server did not become ready: ${stderr.slice(-500)}`);
}

export async function ensureManagedModelServer(
  options: EnsureManagedModelOptions,
): Promise<ManagedModelEndpoint> {
  if (serverChild && serverEndpoint && serverChild.exitCode === null) return serverEndpoint;
  if (serverPromise) return serverPromise;
  const timeout = options.startupTimeout === undefined ? 120000 : options.startupTimeout;
  serverPromise = (async () => {
    const modelPath = await ensureManagedModelFile(
      options.paths, options.onProgress, options.signal,
    );
    if (options.onProgress) options.onProgress({ stage: 'starting' });
    const endpoint = await startManagedServer(options.paths, modelPath, timeout, options.signal);
    serverEndpoint = endpoint;
    return endpoint;
  })();
  try {
    return await serverPromise;
  } finally {
    serverPromise = undefined;
  }
}

export function stopManagedModelServer(): void {
  if (serverChild && serverChild.exitCode === null) serverChild.kill();
  serverChild = undefined;
  serverEndpoint = undefined;
  serverPromise = undefined;
}
