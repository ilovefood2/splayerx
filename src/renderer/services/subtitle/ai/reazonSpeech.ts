/** Minimal local ReazonSpeech K2 v2 support for Japanese subtitle generation. */

import { createHash } from 'crypto';
import { spawn } from 'child_process';
import {
  createReadStream, createWriteStream, existsSync, mkdirSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from 'fs';
import { IncomingMessage } from 'http';
import { join } from 'path';
import { TimedText } from './realtimeTranslator';
import { durationOf } from './transcribe';

export const REAZON_SPEECH_REPOSITORY = 'reazon-research/reazonspeech-k2-v2';
export const REAZON_SPEECH_REVISION = '291488c8151be24d7da4bf7af26e533fad96e407';

export interface ReazonSpeechModelFile {
  fileName: string;
  bytes: number;
  sha256: string;
}

/** Files published by Reazon at the fixed revision above. */
export const REAZON_SPEECH_MODEL_FILES: readonly ReazonSpeechModelFile[] = [
  {
    fileName: 'encoder-epoch-99-avg-1.int8.onnx',
    bytes: 154670139,
    sha256: '2c7bd08a8a99f9ddd0d9e458456577b1f6279214e51426f114f9eced44c54e1d',
  },
  {
    fileName: 'decoder-epoch-99-avg-1.onnx',
    bytes: 11767836,
    sha256: '58b18211ae06265466bfa17172dab574df94f76c8bcb61a3640c28ba860e4124',
  },
  {
    fileName: 'joiner-epoch-99-avg-1.int8.onnx',
    bytes: 2696970,
    sha256: '49cc7ea1d3d35a40a27442db5e89996da64bf0e683a903dce76e99e57a12e4de',
  },
  {
    fileName: 'tokens.txt',
    bytes: 45754,
    sha256: '2c3ac659818a48a0c04010e0593bbc4d7c8a24a054340b01131499c05fd52def',
  },
];

export const REAZON_SPEECH_TOTAL_BYTES = REAZON_SPEECH_MODEL_FILES
  .reduce((total, file) => total + file.bytes, 0);

const MODEL_MARKER_NAME = '.reazonspeech-k2-v2.sha256';

export const REAZON_SPEECH_MODEL_MARKER = `${JSON.stringify({
  revision: REAZON_SPEECH_REVISION,
  files: REAZON_SPEECH_MODEL_FILES.map(file => ({
    fileName: file.fileName,
    bytes: file.bytes,
    sha256: file.sha256,
  })),
})}\n`;

export interface ReazonSpeechModelPaths {
  encoderPath: string;
  decoderPath: string;
  joinerPath: string;
  tokensPath: string;
}

export function reazonSpeechModelPaths(modelDir: string): ReazonSpeechModelPaths {
  return {
    encoderPath: join(modelDir, REAZON_SPEECH_MODEL_FILES[0].fileName),
    decoderPath: join(modelDir, REAZON_SPEECH_MODEL_FILES[1].fileName),
    joinerPath: join(modelDir, REAZON_SPEECH_MODEL_FILES[2].fileName),
    tokensPath: join(modelDir, REAZON_SPEECH_MODEL_FILES[3].fileName),
  };
}

export function reazonSpeechMarkerPath(modelDir: string): string {
  return join(modelDir, MODEL_MARKER_NAME);
}

export type ReazonSpeechDownloadStage = 'downloading' | 'verifying';

export interface ReazonSpeechDownloadProgress {
  stage: ReazonSpeechDownloadStage;
  received: number;
  total: number;
  fileName: string;
}

export interface EnsureReazonSpeechModelOptions {
  modelDir: string;
  onProgress?: (progress: ReazonSpeechDownloadProgress) => void;
  signal?: AbortSignal;
}

function removeIfPresent(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch (error) {
    // A subsequent write reports a more useful error if cleanup really failed.
  }
}

/** Hash one model file without loading it into memory. */
export function sha256ReazonSpeechFile(
  path: string,
  signal?: AbortSignal,
  onProgress?: (received: number, total: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const total = statSync(path).size;
    const hash = createHash('sha256');
    const input = createReadStream(path);
    let received = 0;
    const onAbort = () => input.destroy(new Error('aborted'));

    if (signal) {
      if (signal.aborted) {
        input.destroy();
        reject(new Error('aborted'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    if (onProgress) onProgress(0, total);
    input.on('data', (chunk: Buffer) => {
      hash.update(chunk);
      received += chunk.length;
      if (onProgress) onProgress(received, total);
    });
    input.on('error', reject);
    input.on('end', () => resolve(hash.digest('hex')));
    input.on('close', () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    });
  });
}

function fetchToFile(
  url: string,
  destination: string,
  onProgress?: (received: number) => void,
  signal?: AbortSignal,
  redirects = 0,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    // eslint-disable-next-line global-require
    const https = require('https');
    const request = https.get(url, (response: IncomingMessage) => {
      const status = response.statusCode as number;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        if (redirects >= 5) {
          reject(new Error('too many redirects'));
          return;
        }
        fetchToFile(
          new URL(location, url).toString(), destination, onProgress, signal, redirects + 1,
        ).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`ReazonSpeech download failed: HTTP ${status}`));
        return;
      }
      let received = 0;
      const output = createWriteStream(destination, { flags: 'w' });
      response.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (onProgress) onProgress(received);
      });
      response.on('error', reject);
      output.on('error', reject);
      output.on('finish', resolve);
      response.pipe(output);
    });
    request.on('error', reject);
    if (signal) {
      signal.addEventListener(
        'abort', () => request.destroy(new Error('aborted')), { once: true },
      );
    }
  });
}

function modelFileUrl(file: ReazonSpeechModelFile): string {
  return [
    `https://huggingface.co/${REAZON_SPEECH_REPOSITORY}/resolve/`,
    `${REAZON_SPEECH_REVISION}/${file.fileName}?download=true`,
  ].join('');
}

/**
 * Download and verify the official four-file model. Individual files become
 * visible only after their checksum passes, and the set becomes ready only
 * after the final marker is atomically renamed into place.
 */
export async function ensureReazonSpeechModel(
  options: EnsureReazonSpeechModelOptions,
): Promise<ReazonSpeechModelPaths> {
  const { modelDir, onProgress, signal } = options;
  mkdirSync(modelDir, { recursive: true });

  const marker = reazonSpeechMarkerPath(modelDir);
  removeIfPresent(marker);
  removeIfPresent(`${marker}.part`);
  let completed = 0;
  let highWater = 0;
  const report = (stage: ReazonSpeechDownloadStage, fileName: string, value: number) => {
    if (!onProgress) return;
    highWater = Math.max(highWater, Math.min(REAZON_SPEECH_TOTAL_BYTES, value));
    onProgress({ stage, fileName, received: highWater, total: REAZON_SPEECH_TOTAL_BYTES });
  };

  for (let index = 0; index < REAZON_SPEECH_MODEL_FILES.length; index += 1) {
    const file = REAZON_SPEECH_MODEL_FILES[index];
    const destination = join(modelDir, file.fileName);
    let digest = '';
    if (existsSync(destination) && statSync(destination).size === file.bytes) {
      // eslint-disable-next-line no-await-in-loop
      digest = await sha256ReazonSpeechFile(destination, signal, (received) => {
        report('verifying', file.fileName, completed + Math.min(received, file.bytes));
      });
    }

    if (digest !== file.sha256) {
      const part = `${destination}.part`;
      removeIfPresent(part);
      try {
        // Downloads stay sequential: the encoder dominates the total and four
        // concurrent writes would only make cancellation and progress noisier.
        // eslint-disable-next-line no-await-in-loop
        await fetchToFile(modelFileUrl(file), part, (received) => {
          report('downloading', file.fileName, completed + Math.min(received, file.bytes));
        }, signal);
        if (statSync(part).size !== file.bytes) {
          throw new Error(`ReazonSpeech ${file.fileName} has an unexpected size`);
        }
        // eslint-disable-next-line no-await-in-loop
        const downloadedDigest = await sha256ReazonSpeechFile(part, signal, (received) => {
          report('verifying', file.fileName, completed + Math.min(received, file.bytes));
        });
        if (downloadedDigest !== file.sha256) {
          throw new Error(`ReazonSpeech ${file.fileName} checksum mismatch`);
        }
        // POSIX replaces atomically. Unlink first only on platforms where an
        // existing invalid destination prevents rename.
        try {
          renameSync(part, destination);
        } catch (error) {
          removeIfPresent(destination);
          renameSync(part, destination);
        }
      } catch (error) {
        removeIfPresent(part);
        throw error;
      }
    }
    completed += file.bytes;
    report('verifying', file.fileName, completed);
  }

  const markerPart = `${marker}.part`;
  writeFileSync(markerPart, REAZON_SPEECH_MODEL_MARKER, { mode: 0o600 });
  renameSync(markerPart, marker);
  return reazonSpeechModelPaths(modelDir);
}

/** Arguments for the bundled sherpa-onnx-offline transducer. */
export function reazonSpeechCliArgs(
  paths: ReazonSpeechModelPaths,
  wavPaths: string | string[],
): string[] {
  return [
    `--tokens=${paths.tokensPath}`,
    `--encoder=${paths.encoderPath}`,
    `--decoder=${paths.decoderPath}`,
    `--joiner=${paths.joinerPath}`,
    '--model-type=transducer',
    '--provider=cpu',
    '--num-threads=2',
    '--decoding-method=greedy_search',
    '--print-args=false',
  ].concat(Array.isArray(wavPaths) ? wavPaths : [wavPaths]);
}

export interface ReazonSpeechToken {
  text: string;
  /** Absolute media timestamp in seconds. */
  start: number;
}

interface ReazonSpeechJson {
  text: string;
  tokens: string[];
  timestamps: number[];
}

/**
 * Parse exactly one sherpa JSON object. Logs, partial JSON, unaligned arrays and
 * token/text disagreement are errors; accepting them would silently corrupt
 * chunk stitching and subtitle timing.
 */
export function parseReazonSpeechStdout(
  stdout: string,
  offset = 0,
): ReazonSpeechToken[] {
  if (!Number.isFinite(offset)) throw new Error('invalid ReazonSpeech timestamp offset');
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch (error) {
    throw new Error('ReazonSpeech stdout must contain exactly one JSON object');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ReazonSpeech stdout must contain exactly one JSON object');
  }
  const json = value as ReazonSpeechJson;
  if (typeof json.text !== 'string'
    || !Array.isArray(json.tokens)
    || !Array.isArray(json.timestamps)
    || json.tokens.length !== json.timestamps.length) {
    throw new Error('ReazonSpeech JSON has unaligned text, tokens, or timestamps');
  }
  if (json.tokens.some(token => typeof token !== 'string' || token.length === 0)
    || json.tokens.join('') !== json.text) {
    throw new Error('ReazonSpeech JSON token text does not match recognized text');
  }

  let previous = -1;
  return json.tokens.map((text, index) => {
    const relative = json.timestamps[index];
    if (!Number.isFinite(relative) || relative < 0 || relative < previous) {
      throw new Error('ReazonSpeech JSON timestamps must be finite and monotonic');
    }
    previous = relative;
    return { text, start: offset + relative };
  });
}

export interface ReazonSpeechChunk {
  /** Audio actually passed to sherpa, including any overlap. */
  inputStart: number;
  inputEnd: number;
  /** Non-overlapped ownership interval. */
  coreStart: number;
  coreEnd: number;
  tokens: ReazonSpeechToken[];
}

const STITCH_WINDOW = 96;
const MIN_STITCH_TOKENS = 4;
const TIMESTAMP_EPSILON = 0.05;

function validateChunk(chunk: ReazonSpeechChunk): void {
  const bounds = [chunk.inputStart, chunk.inputEnd, chunk.coreStart, chunk.coreEnd];
  if (bounds.some(value => !Number.isFinite(value))
    || chunk.inputStart > chunk.coreStart
    || chunk.coreStart > chunk.coreEnd
    || chunk.coreEnd > chunk.inputEnd) {
    throw new Error('invalid ReazonSpeech chunk bounds');
  }
  let previous = -Infinity;
  chunk.tokens.forEach((token) => {
    if (!token.text || !Number.isFinite(token.start) || token.start < previous) {
      throw new Error('invalid ReazonSpeech chunk tokens');
    }
    previous = token.start;
  });
}

/** Remove only an isolated katakana token emitted inside the leading zero pad. */
function withoutObservedPaddingArtifact(chunk: ReazonSpeechChunk): ReazonSpeechToken[] {
  if (chunk.tokens.length < 2) return chunk.tokens.slice();
  const first = chunk.tokens[0];
  const next = chunk.tokens[1];
  const atWindowStart = Math.abs(first.start - chunk.inputStart) <= TIMESTAMP_EPSILON;
  if (chunk.coreStart === 0
    && /^[\u30a1-\u30f6\u30fc]$/.test(first.text)
    && atWindowStart
    && next.start - first.start >= 1.5) {
    return chunk.tokens.slice(1);
  }
  return chunk.tokens.slice();
}

function exactSuffixPrefixLength(
  previous: ReazonSpeechToken[],
  current: ReazonSpeechToken[],
): number {
  const maximum = Math.min(STITCH_WINDOW, previous.length, current.length);
  for (let length = maximum; length >= MIN_STITCH_TOKENS; length -= 1) {
    let matches = true;
    for (let index = 0; index < length; index += 1) {
      if (previous[previous.length - length + index].text !== current[index].text) {
        matches = false;
        break;
      }
    }
    if (matches) return length;
  }
  return 0;
}

function hasSpeechBetween(tokens: ReazonSpeechToken[], start: number, end: number): boolean {
  return tokens.some(token => token.start >= start - TIMESTAMP_EPSILON
    && token.start <= end + TIMESTAMP_EPSILON);
}

function wordMidpoint(tokens: ReazonSpeechToken[], unit: WordUnit): number {
  const first = tokens[unit.first].start;
  const last = tokens[unit.last].start;
  return first + (last - first) / 2;
}

/** Deduplicate exact overlaps and choose whole Japanese words at disputed seams. */
export function stitchReazonChunks(chunks: ReazonSpeechChunk[]): ReazonSpeechToken[] {
  if (!chunks.length) return [];
  chunks.forEach(validateChunk);
  let previousChunk = chunks[0];
  let previousTokens = withoutObservedPaddingArtifact(previousChunk);
  const stitched = previousTokens.slice();

  for (let index = 1; index < chunks.length; index += 1) {
    const currentChunk = chunks[index];
    if (currentChunk.coreStart < previousChunk.coreStart) {
      throw new Error('ReazonSpeech chunks must be ordered by core timestamp');
    }
    const currentTokens = withoutObservedPaddingArtifact(currentChunk);
    const matched = exactSuffixPrefixLength(previousTokens, currentTokens);
    if (matched > 0) {
      stitched.push(...currentTokens.slice(matched));
    } else {
      const overlapStart = Math.max(previousChunk.inputStart, currentChunk.inputStart);
      const overlapEnd = Math.min(previousChunk.inputEnd, currentChunk.inputEnd);
      const ambiguous = overlapStart < overlapEnd
        && hasSpeechBetween(previousTokens, overlapStart, overlapEnd)
        && hasSpeechBetween(currentTokens, overlapStart, overlapEnd);
      if (ambiguous) {
        // Independent windows can spell the same phrase differently. Avoid
        // fuzzy text matching: keep complete words from the earlier window
        // before the core boundary and complete words from the later one after.
        const previousUnits = wordUnitsOf(stitched);
        const previousCutUnit = previousUnits.find(unit => (
          wordMidpoint(stitched, unit) >= currentChunk.coreStart
        ));
        const previousCut = previousCutUnit ? previousCutUnit.first : stitched.length;
        const currentUnits = wordUnitsOf(currentTokens);
        const currentStartUnit = currentUnits.find(unit => (
          wordMidpoint(currentTokens, unit) >= currentChunk.coreStart
        ));
        const currentStart = currentStartUnit ? currentStartUnit.first : currentTokens.length;
        stitched.splice(previousCut);
        stitched.push(...currentTokens.slice(currentStart));
      } else {
        stitched.push(...currentTokens);
      }
    }
    previousChunk = currentChunk;
    previousTokens = currentTokens;
  }
  let lastTimestamp = 0;
  return stitched.map((token) => {
    const start = Math.max(lastTimestamp, token.start);
    lastTimestamp = start;
    return { ...token, start };
  });
}

export interface ReazonSpeechCueOptions {
  pauseSeconds?: number;
  maxCharacters?: number;
  maxDuration?: number;
}

interface WordUnit {
  first: number;
  last: number;
}

function wordUnitsOf(tokens: ReazonSpeechToken[]): WordUnit[] {
  const text = tokens.map(token => token.text).join('');
  const tokenStarts: number[] = [];
  const tokenEnds: number[] = [];
  let offset = 0;
  tokens.forEach((token) => {
    tokenStarts.push(offset);
    offset += token.text.length;
    tokenEnds.push(offset);
  });
  const segments = new Intl.Segmenter('ja', { granularity: 'word' }).segment(text);
  const units: WordUnit[] = [];
  Array.from(segments).forEach((segment) => {
    const start = segment.index;
    const end = start + segment.segment.length;
    const first = tokenEnds.findIndex(tokenEnd => tokenEnd > start);
    let last = tokenStarts.length - 1;
    for (let index = Math.max(0, first); index < tokenStarts.length; index += 1) {
      if (tokenStarts[index] >= end) {
        last = index - 1;
        break;
      }
    }
    if (first < 0 || last < first) return;
    const previous = units[units.length - 1];
    // Punctuation and whitespace stay with the word before them. If a model
    // token itself crosses a segment boundary, merge instead of splitting it.
    if (previous && (segment.isWordLike === false || first <= previous.last)) {
      previous.last = Math.max(previous.last, last);
    } else {
      units.push({ first, last });
    }
  });
  return units;
}

function characterCount(text: string): number {
  return Array.from(text).length;
}

/** Convert character timestamps to readable Japanese cues without splitting a word. */
export function cueizeReazonWords(
  tokens: ReazonSpeechToken[],
  options: ReazonSpeechCueOptions = {},
): TimedText[] {
  if (!tokens.length) return [];
  const pauseSeconds = options.pauseSeconds === undefined ? 0.8 : options.pauseSeconds;
  const maxCharacters = options.maxCharacters === undefined ? 40 : options.maxCharacters;
  const maxDuration = options.maxDuration === undefined ? 8 : options.maxDuration;
  if (!(pauseSeconds > 0) || !(maxCharacters > 0) || !(maxDuration > 0)) {
    throw new Error('invalid ReazonSpeech cue limits');
  }
  for (let index = 0; index < tokens.length; index += 1) {
    if (!tokens[index].text || !Number.isFinite(tokens[index].start)
      || (index > 0 && tokens[index].start < tokens[index - 1].start)) {
      throw new Error('invalid ReazonSpeech cue tokens');
    }
  }

  const units = wordUnitsOf(tokens);
  const cues: TimedText[] = [];
  let cueFirstUnit = 0;
  const tokenText = (first: number, last: number) => tokens
    .slice(first, last + 1).map(token => token.text).join('').trim();
  const flush = (lastUnit: number, nextStart?: number) => {
    const firstToken = units[cueFirstUnit].first;
    const lastToken = units[lastUnit].last;
    const text = tokenText(firstToken, lastToken);
    if (!text) return;
    const start = tokens[firstToken].start;
    const naturalEnd = tokens[lastToken].start + Math.min(0.5, pauseSeconds);
    const boundedByNext = nextStart === undefined ? naturalEnd : Math.min(naturalEnd, nextStart);
    const end = Math.max(start + 0.05, Math.min(start + maxDuration, boundedByNext));
    cues.push({ start, end, text });
  };

  for (let unitIndex = 1; unitIndex < units.length; unitIndex += 1) {
    const previousUnit = units[unitIndex - 1];
    const unit = units[unitIndex];
    const nextStart = tokens[unit.first].start;
    const pause = nextStart - tokens[previousUnit.last].start >= pauseSeconds;
    const candidateText = tokenText(units[cueFirstUnit].first, unit.last);
    const candidateDuration = tokens[unit.last].start
      - tokens[units[cueFirstUnit].first].start + Math.min(0.5, pauseSeconds);
    const exceedsLimit = characterCount(candidateText) > maxCharacters
      || candidateDuration > maxDuration;
    if (pause || exceedsLimit) {
      flush(unitIndex - 1, nextStart);
      cueFirstUnit = unitIndex;
    }
  }
  flush(units.length - 1);

  return cues;
}

export const REAZON_SPEECH_CORE_SECONDS = 24;
export const REAZON_SPEECH_OVERLAP_SECONDS = 2;
const REAZON_SPEECH_PADDING_SECONDS = 0.9;

export interface ReazonSpeechTranscribeEnvironment {
  runtimePath: string;
  ffmpegPath: string;
  ffprobePath: string;
  modelPaths: ReazonSpeechModelPaths;
}

export interface ReazonSpeechTranscribeOptions {
  tmpDir: string;
  duration?: number;
  priorityTime?: number;
  onProgress?: (percent: number) => void;
  onCues?: (
    cues: TimedText[], info: { language: string, done: number, total: number },
  ) => void | Promise<void>;
  signal?: AbortSignal;
}

export function reazonSpeechChunkPlanOf(duration: number): ReazonSpeechChunk[] {
  if (!(duration > 0)) return [];
  const chunks: ReazonSpeechChunk[] = [];
  for (let coreStart = 0; coreStart < duration; coreStart += REAZON_SPEECH_CORE_SECONDS) {
    const coreEnd = Math.min(duration, coreStart + REAZON_SPEECH_CORE_SECONDS);
    chunks.push({
      coreStart,
      coreEnd,
      inputStart: Math.max(0, coreStart - REAZON_SPEECH_OVERLAP_SECONDS),
      inputEnd: Math.min(duration, coreEnd + REAZON_SPEECH_OVERLAP_SECONDS),
      tokens: [],
    });
  }
  return chunks;
}

interface RunCommandOptions {
  signal?: AbortSignal;
  captureStdout?: boolean;
}

function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';
    const onAbort = () => child.kill();
    if (options.captureStdout) {
      child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    }
    child.stderr.on('data', (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-8000);
    });
    child.on('error', reject);
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('close', (code) => {
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited with ${code}: ${stderr.slice(-500)}`));
    });
  });
}

function reportReazonProgress(
  callback: ((percent: number) => void) | undefined,
  percent: number,
): void {
  if (callback) callback(Math.max(0, Math.min(100, Math.round(percent * 10) / 10)));
}

function prioritizedReazonSequences(
  chunks: ReazonSpeechChunk[],
  priorityTime?: number,
): ReazonSpeechChunk[][] {
  if (priorityTime === undefined || !Number.isFinite(priorityTime) || chunks.length < 2) {
    return [chunks];
  }
  const index = chunks.findIndex((chunk, chunkIndex) => (
    priorityTime >= chunk.coreStart
      && (chunkIndex === chunks.length - 1
        ? priorityTime <= chunk.coreEnd : priorityTime < chunk.coreEnd)
  ));
  if (index <= 0) return [chunks];
  return [chunks.slice(index), chunks.slice(0, index)];
}

function cuesOwnedByReazonCore(
  cues: TimedText[],
  chunk: ReazonSpeechChunk,
  mediaDuration: number,
): TimedText[] {
  const last = chunk.coreEnd >= mediaDuration;
  return cues.filter((cue) => {
    const midpoint = cue.start + (cue.end - cue.start) / 2;
    return midpoint >= chunk.coreStart && (last ? midpoint <= chunk.coreEnd : midpoint < chunk.coreEnd);
  });
}

async function recognizeReazonChunk(
  videoPath: string,
  environment: ReazonSpeechTranscribeEnvironment,
  chunk: ReazonSpeechChunk,
  wavPath: string,
  signal?: AbortSignal,
): Promise<ReazonSpeechChunk> {
  try {
    await runCommand(environment.ffmpegPath, [
      '-y', '-v', 'error', '-ss', String(chunk.inputStart),
      '-t', String(chunk.inputEnd - chunk.inputStart), '-i', videoPath,
      '-vn', '-ac', '1', '-ar', '16000',
      '-af', 'adelay=900:all=1,apad=pad_dur=0.9',
      '-c:a', 'pcm_s16le', wavPath,
    ], { signal });
    const stdout = await runCommand(
      environment.runtimePath,
      reazonSpeechCliArgs(environment.modelPaths, wavPath),
      { signal, captureStdout: true },
    );
    const tokens = parseReazonSpeechStdout(
      stdout, chunk.inputStart - REAZON_SPEECH_PADDING_SECONDS,
    ).map(token => ({
      ...token,
      start: Math.max(chunk.inputStart, Math.min(chunk.inputEnd, token.start)),
    }));
    return { ...chunk, tokens };
  } finally {
    removeIfPresent(wavPath);
  }
}

/** Generate Japanese cues locally, emitting the playhead window first. */
export async function transcribeVideoWithReazonSpeech(
  videoPath: string,
  environment: ReazonSpeechTranscribeEnvironment,
  options: ReazonSpeechTranscribeOptions,
): Promise<{ language: string, cues: TimedText[] }> {
  reportReazonProgress(options.onProgress, 0.1);
  const duration = options.duration && options.duration > 0
    ? options.duration : await durationOf(environment.ffprobePath, videoPath);
  const chunks = reazonSpeechChunkPlanOf(duration);
  if (!chunks.length) throw new Error('ReazonSpeech could not determine media duration');

  mkdirSync(options.tmpDir, { recursive: true });
  const stamp = `splayer-reazon-${Date.now()}`;
  const sequences = prioritizedReazonSequences(chunks, options.priorityTime);
  const allCues: TimedText[] = [];
  let completed = 0;
  let recognized = 0;

  const recognize = async (chunk: ReazonSpeechChunk): Promise<ReazonSpeechChunk> => {
    if (options.signal && options.signal.aborted) throw new Error('aborted');
    const result = await recognizeReazonChunk(
      videoPath,
      environment,
      chunk,
      join(options.tmpDir, `${stamp}-${chunk.coreStart}.wav`),
      options.signal,
    );
    recognized += 1;
    reportReazonProgress(options.onProgress, 5 + (recognized / chunks.length) * 90);
    return result;
  };
  const emit = async (cues: TimedText[]) => {
    completed += 1;
    allCues.push(...cues);
    if (options.onCues) {
      await options.onCues(cues, { language: 'ja', done: completed, total: chunks.length });
    }
  };

  for (let sequenceIndex = 0; sequenceIndex < sequences.length; sequenceIndex += 1) {
    const sequence = sequences[sequenceIndex];
    if (!sequence.length) continue;
    // eslint-disable-next-line no-await-in-loop
    let previous = await recognize(sequence[0]);
    for (let index = 1; index < sequence.length; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      const current = await recognize(sequence[index]);
      const cues = cuesOwnedByReazonCore(
        cueizeReazonWords(stitchReazonChunks([previous, current])),
        previous,
        duration,
      );
      // eslint-disable-next-line no-await-in-loop
      await emit(cues);
      previous = current;
    }
    const finalCues = cuesOwnedByReazonCore(
      cueizeReazonWords(previous.tokens), previous, duration,
    );
    // eslint-disable-next-line no-await-in-loop
    await emit(finalCues);
  }
  reportReazonProgress(options.onProgress, 100);
  allCues.sort((left, right) => left.start - right.start);
  return { language: 'ja', cues: allCues };
}
