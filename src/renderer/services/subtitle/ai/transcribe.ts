/**
 * Local speech-to-subtitle via whisper.cpp.
 *
 * For a video with no usable subtitle track there is nothing to translate, so we
 * make one: extract the audio with ffmpeg, transcribe it with whisper-cli, and
 * hand the cues to the normal AI translation pipeline.
 *
 * The packaged app ships its own whisper-cli + ffmpeg (see bundle-whisper.sh and
 * gen-electron-builder-config.js), so this works on a fresh Mac with nothing
 * installed; a Homebrew install is used as a fallback in dev. A packaged .app
 * does NOT inherit the shell PATH, so everything is resolved by absolute path —
 * bundled dirs first — and reported precisely when missing.
 *
 * NOTE: explicit `=== undefined` checks rather than `??`/`?.` — see ollama.ts.
 */

import { spawn } from 'child_process';
import {
  existsSync, readFileSync, unlinkSync, createWriteStream, mkdirSync, renameSync,
} from 'fs';
import { IncomingMessage } from 'http';
import { join } from 'path';
import { TimedText } from './realtimeTranslator';

export type TranscribeTool = 'whisper' | 'ffmpeg' | 'model';

export interface TranscribeEnvironment {
  ok: boolean;
  whisperPath?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  modelPath?: string;
  /**
   * Silero VAD model. Optional, but without it whisper invents dialogue over
   * music and silence — see VAD_THRESHOLD.
   */
  vadModelPath?: string;
  /** Where the model would be downloaded to, if it needs to be. */
  modelDir?: string;
  /** Which pieces are missing, so the UI can name them exactly. */
  missing: TranscribeTool[];
}

/**
 * Paths into the app bundle, passed in by the caller (this module stays free of
 * electron). `binDir` holds the bundled ffmpeg/ffprobe; `whisperDir` holds the
 * self-contained whisper-cli and its backend .so files (see bundle-whisper.sh).
 */
export interface BundledPaths {
  binDir?: string;
  whisperDir?: string;
}

export interface TranscribeResult {
  /** BCP-47-ish code whisper detected, e.g. 'ja'. */
  language: string;
  cues: TimedText[];
}

/** Homebrew on Apple Silicon, Homebrew on Intel, then the system prefix. */
const BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

const WHISPER_NAMES = ['whisper-cli', 'whisper-cpp', 'whisper'];

function findBinary(names: string[], extraDirs: string[] = []): string | undefined {
  const dirs = extraDirs.concat(BIN_DIRS);
  for (let i = 0; i < dirs.length; i += 1) {
    for (let j = 0; j < names.length; j += 1) {
      const candidate = join(dirs[i], names[j]);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Any ggml model the user has put where we look, preferring the best one. */
const MODEL_NAMES = [
  'ggml-large-v3-turbo.bin',
  'ggml-large-v3.bin',
  'ggml-large.bin',
  'ggml-medium.bin',
  'ggml-large-v3-turbo-q8_0.bin',
  'ggml-large-v3-turbo-q5_0.bin', // what we auto-download
  'ggml-small.bin',
  'ggml-base.bin',
];

const VAD_MODEL_NAMES = ['ggml-silero-v5.1.2.bin', 'ggml-silero.bin'];

function findFile(searchDirs: string[], names: string[]): string | undefined {
  for (let i = 0; i < searchDirs.length; i += 1) {
    for (let j = 0; j < names.length; j += 1) {
      const candidate = join(searchDirs[i], names[j]);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** whisper.cpp ggml models and the Silero VAD model live on Hugging Face. */
const MODEL_REPO = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
const VAD_REPO = 'https://huggingface.co/ggml-org/whisper-vad/resolve/main';

/**
 * The model auto-downloaded on first use: quantized large-v3-turbo. Best
 * accuracy-for-size of the turbo line (~550 MB vs ~1.6 GB unquantized), so a
 * fresh Mac becomes usable after one moderate download rather than a huge one.
 */
export const DEFAULT_MODEL_NAME = 'ggml-large-v3-turbo-q5_0.bin';
export const VAD_MODEL_NAME = 'ggml-silero-v5.1.2.bin';

export interface DownloadProgress {
  /** Bytes received so far for the file currently downloading. */
  received: number;
  /** Total bytes, or 0 if the server didn't send Content-Length. */
  total: number;
}

export interface DownloadModelOptions {
  /** Directory to download into; created if absent. */
  modelDir: string;
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
}

/** GET `url` into `dest`, following redirects (HF resolve URLs redirect to a CDN). */
function fetchToFile(
  url: string,
  dest: string,
  onData?: (received: number, total: number) => void,
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
    const request = https.get(url, (res: IncomingMessage) => {
      const status = res.statusCode as number;
      const { location } = res.headers;
      if (status >= 300 && status < 400 && location) {
        res.resume(); // drain so the socket frees
        if (redirects > 5) { reject(new Error('too many redirects')); return; }
        fetchToFile(location, dest, onData, signal, redirects + 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`download failed: HTTP ${status}`));
        return;
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      const out = createWriteStream(dest);
      res.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (onData) onData(received, total);
      });
      res.on('error', reject);
      out.on('error', reject);
      // 'finish' fires once all data is flushed; the stream auto-closes its fd,
      // and renameSync works on POSIX even before the fd is fully released.
      out.on('finish', () => resolve());
      res.pipe(out);
    });
    request.on('error', reject);
    if (signal) {
      signal.addEventListener('abort', () => request.destroy(new Error('aborted')), { once: true });
    }
  });
}

/**
 * Fetch the default model (and the small VAD model) into `modelDir` if not
 * already there. Downloads to a `.part` file and renames on success so an
 * interrupted download never leaves a truncated model that looks complete.
 */
export async function downloadModel(
  options: DownloadModelOptions,
): Promise<{ modelPath: string, vadModelPath?: string }> {
  const { modelDir, onProgress, signal } = options;
  mkdirSync(modelDir, { recursive: true });

  const modelPath = join(modelDir, DEFAULT_MODEL_NAME);
  if (!existsSync(modelPath)) {
    const part = `${modelPath}.part`;
    await fetchToFile(
      `${MODEL_REPO}/${DEFAULT_MODEL_NAME}`, part,
      onProgress ? (received, total) => onProgress({ received, total }) : undefined,
      signal,
    );
    renameSync(part, modelPath);
  }

  // The VAD model is ~2 MB and stops whisper hallucinating over music/silence,
  // so grab it too; a failure here is non-fatal (transcription still works).
  let vadModelPath: string | undefined;
  const vadDest = join(modelDir, VAD_MODEL_NAME);
  try {
    if (!existsSync(vadDest)) {
      const part = `${vadDest}.part`;
      await fetchToFile(`${VAD_REPO}/${VAD_MODEL_NAME}`, part, undefined, signal);
      renameSync(part, vadDest);
    }
    vadModelPath = vadDest;
  } catch (error) {
    // Cancelling the operation must cancel the whole setup. Only ordinary VAD
    // download failures are optional; swallowing an abort would immediately
    // start a long transcription after the user had asked it to stop.
    if (signal && signal.aborted) throw error;
    vadModelPath = undefined;
  }

  return { modelPath, vadModelPath };
}

/**
 * Locate everything transcription needs, preferring what ships inside the app.
 * `userDataPath`/`home` are passed in (not imported) so this module stays
 * testable and free of electron; `bundled` carries the in-app binary dirs.
 */
export function checkTranscribeEnvironment(
  userDataPath?: string,
  home?: string,
  bundled: BundledPaths = {},
): TranscribeEnvironment {
  const modelDirs: string[] = [];
  if (userDataPath) modelDirs.push(join(userDataPath, 'whisper'));
  if (home) {
    modelDirs.push(join(home, 'Library', 'Application Support', 'SPlayer', 'whisper'));
    modelDirs.push(join(home, '.cache', 'whisper'));
  }
  modelDirs.push('/opt/homebrew/share/whisper-cpp');

  // Bundled binaries win over a Homebrew install, so a fresh Mac works with no
  // setup; Homebrew is the fallback in dev or if the bundle is absent.
  const whisperExtra = bundled.whisperDir ? [bundled.whisperDir] : [];
  const binExtra = bundled.binDir ? [bundled.binDir] : [];
  const whisperPath = findBinary(WHISPER_NAMES, whisperExtra);
  const ffmpegPath = findBinary(['ffmpeg'], binExtra);
  // ffprobe ships with ffmpeg; we need it to know how long the video is.
  const ffprobePath = findBinary(['ffprobe'], binExtra);
  const modelPath = findFile(modelDirs, MODEL_NAMES);
  const vadModelPath = findFile(modelDirs, VAD_MODEL_NAMES);

  const missing: TranscribeTool[] = [];
  if (!whisperPath) missing.push('whisper');
  if (!ffmpegPath || !ffprobePath) missing.push('ffmpeg');
  if (!modelPath) missing.push('model');

  return {
    ok: missing.length === 0,
    whisperPath,
    ffmpegPath,
    ffprobePath,
    modelPath,
    vadModelPath,
    modelDir: modelDirs[0],
    missing,
  };
}

function capture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = '';
    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.on('error', reject);
    child.on('close', () => resolve(stdout));
  });
}

/** Video duration in seconds, or 0 when ffprobe cannot tell us. */
export async function durationOf(ffprobePath: string, videoPath: string): Promise<number> {
  const out = await capture(ffprobePath, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    videoPath,
  ]).catch(() => '');
  const seconds = parseFloat(out.trim());
  if (Number.isNaN(seconds) || seconds <= 0) return 0;
  return seconds;
}

interface RunOptions {
  onStderr?: (chunk: string) => void;
  signal?: AbortSignal;
}

function run(command: string, args: string[], options: RunOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stderr = '';
    const onAbort = () => child.kill();
    child.stderr.on('data', (data: Buffer) => {
      const text = data.toString();
      // whisper-cli reports progress on stderr; keep only the tail for errors.
      stderr = (stderr + text).slice(-4000);
      if (options.onStderr) options.onStderr(text);
    });
    child.on('error', reject);
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('close', (code) => {
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}: ${stderr.slice(-400)}`));
    });
  });
}

/** whisper-cli reports `n%` on stderr while decoding. */
function parseProgress(chunk: string): number | undefined {
  const matched = /progress\s*=\s*(\d+)%/i.exec(chunk);
  if (!matched) return undefined;
  return parseInt(matched[1], 10);
}

export interface WhisperJson {
  result?: { language?: string };
  transcription?: {
    // milliseconds, verified against whisper.cpp 1.9
    offsets?: { from?: number, to?: number },
    text?: string,
  }[];
}

/**
 * Text whisper is known to invent when it hears no speech.
 *
 * These are memorised from its training data — channel outros, sign-offs and
 * subtitle credits — and it emits them over music and silence with high
 * confidence. VAD is the real defence; this is the backstop for when the VAD
 * model is not installed, and it only matches a whole cue, never a substring of
 * genuine dialogue.
 */
const HALLUCINATIONS = [
  /^ご(?:清|視)聴ありがとうございま(?:した|す)[。.!！]*$/,
  /^おだいじに[。.!！]*$/,
  /^请不吝(?:点赞|點贊)[、,].*$/,
  /^(?:明镜|明鏡)与(?:点点|點點)(?:栏目|欄目)$/,
  /^字幕(?:由|提供).*(?:Amara|amara).*$/,
  /^Subtitles by the Amara\.org community$/i,
  /^(?:Thanks|Thank you) for watching[.!]*$/i,
  /^Please subscribe to (?:my|our) channel[.!]*$/i,
  /^字幕志愿者.*$/,
];

function isHallucination(text: string): boolean {
  return HALLUCINATIONS.some(pattern => pattern.test(text));
}

/** Exported for tests: whisper's offsets are milliseconds, cues want seconds. */
export function parseWhisperCues(json: WhisperJson): TimedText[] {
  const segments = json.transcription;
  if (!segments) return [];
  const cues: TimedText[] = [];
  segments.forEach((segment) => {
    const offsets = segment.offsets;
    const text = segment.text === undefined ? '' : segment.text.trim();
    if (!offsets || offsets.from === undefined || offsets.to === undefined || !text) return;
    // whisper emits [_BEG_]/[Music]-style markers for non-speech; they are noise
    // as subtitles and would waste translation calls.
    if (/^[[(][^)\]]*[)\]]$/.test(text)) return;
    if (isHallucination(text)) return;
    cues.push({ start: offsets.from / 1000, end: offsets.to / 1000, text });
  });
  return cues;
}

export interface TranscribeOptions {
  tmpDir: string;
  /**
   * Spoken language for whisper (ISO-639-1, e.g. 'ja'). Omit to auto-detect.
   * Detection only sniffs the opening seconds, so it misfires on material that
   * opens with music or silence — an explicit language is far more reliable.
   */
  language?: string;
  /** Seconds of audio per chunk. */
  chunkSeconds?: number;
  /** Decoding threads. */
  threads?: number;
  /** Called with each chunk's cues as soon as they are ready. */
  onCues?: (
    cues: TimedText[],
    info: { language: string, done: number, total: number },
  ) => void | Promise<void>;
  signal?: AbortSignal;
}

const DEFAULT_CHUNK_SECONDS = 120;
const DEFAULT_THREADS = 8;

/**
 * Voice-activity threshold.
 *
 * Whisper does not stay quiet when handed music or silence: it emits text it
 * memorised in training, confidently and with plausible timestamps. Measured on
 * a real file whose first minute is music, it invented "thank you for watching"
 * across the whole 60s. VAD removes non-speech audio before whisper ever sees
 * it, which is the only reliable cure.
 *
 * 0.6 rather than the 0.5 default: on that same minute 0.5 still let one
 * fabricated line through, 0.6 produced nothing at all, and 0.6 still
 * transcribes real speech correctly.
 */
const VAD_THRESHOLD = '0.6';

function vadArgs(env: TranscribeEnvironment): string[] {
  if (!env.vadModelPath) return [];
  return ['--vad', '--vad-model', env.vadModelPath, '--vad-threshold', VAD_THRESHOLD];
}

/**
 * Split a duration into chunks. A duration of 0 means ffprobe could not tell us,
 * so fall back to one pass over the whole file.
 */
export function chunkPlanOf(
  duration: number,
  chunkSeconds: number,
): { start: number, length: number }[] {
  if (!(duration > 0) || !(chunkSeconds > 0)) return [{ start: 0, length: 0 }];
  const plan: { start: number, length: number }[] = [];
  for (let start = 0; start < duration; start += chunkSeconds) {
    plan.push({ start, length: Math.min(chunkSeconds, duration - start) });
  }
  return plan;
}

/** One chunk: extract its audio, transcribe it, shift cues onto the real timeline. */
async function transcribeChunk(
  videoPath: string,
  env: TranscribeEnvironment,
  start: number,
  length: number,
  language: string,
  options: TranscribeOptions,
): Promise<{ cues: TimedText[], language: string }> {
  const stamp = `splayer-whisper-${hashOf(videoPath)}-${start}`;
  const wavPath = join(options.tmpDir, `${stamp}.wav`);
  const outPrefix = join(options.tmpDir, stamp);
  const jsonPath = `${outPrefix}.json`;
  const threads = options.threads === undefined ? DEFAULT_THREADS : options.threads;

  try {
    // -ss before -i seeks instead of decoding everything up to `start`.
    // length <= 0 means "to the end of the file", so -t is omitted entirely:
    // `-t 0` would extract nothing.
    const seek = ['-y', '-ss', String(start)];
    const span = length > 0 ? ['-t', String(length)] : [];
    await run(env.ffmpegPath as string, seek.concat(span, [
      '-i', videoPath,
      '-vn', // no video
      '-ac', '1', // mono
      '-ar', '16000', // whisper's native rate
      '-c:a', 'pcm_s16le',
      wavPath,
    ]), { signal: options.signal });

    // whisper-cli loads its compute backends (Metal/BLAS/CPU) from its own
    // directory, so the bundled copy Just Works: bundle-whisper.sh puts the
    // backend .so files right next to the executable in Resources/whisper.
    await run(env.whisperPath as string, [
      '-m', env.modelPath as string,
      '-f', wavPath,
      '-l', language || 'auto',
      '-oj', // JSON output, with millisecond offsets
      '-of', outPrefix,
      '-t', String(threads),
      // Suppress non-speech tokens ([Music] and friends).
      '-sns',
    ].concat(vadArgs(env)), { signal: options.signal });

    if (!existsSync(jsonPath)) return { cues: [], language };
    const json = JSON.parse(readFileSync(jsonPath, 'utf8')) as WhisperJson;
    const detected = json.result && json.result.language ? json.result.language : language;
    // Offsets are relative to the chunk, so shift them onto the real timeline.
    const cues = parseWhisperCues(json).map(cue => ({
      start: cue.start + start,
      end: cue.end + start,
      text: cue.text,
    }));
    return { cues, language: detected };
  } finally {
    [wavPath, jsonPath].forEach((file) => {
      try {
        if (existsSync(file)) unlinkSync(file);
      } catch (e) {
        // best effort; a leftover temp file must never break playback
      }
    });
  }
}

/**
 * Transcribe a video's audio into timed cues, one chunk at a time.
 *
 * Chunking is what makes this usable on a feature-length file. Whisper runs
 * roughly 30x faster than playback, so emitting each chunk as it lands puts
 * subtitles on screen within seconds and keeps them far ahead of the playhead —
 * rather than transcribing three hours before showing anything.
 */
export async function transcribeVideo(
  videoPath: string,
  env: TranscribeEnvironment,
  options: TranscribeOptions,
): Promise<TranscribeResult> {
  if (!env.ok || !env.whisperPath || !env.ffmpegPath || !env.ffprobePath || !env.modelPath) {
    throw new Error(`transcribe environment incomplete: missing ${env.missing.join(', ')}`);
  }
  const chunkSeconds = options.chunkSeconds === undefined
    ? DEFAULT_CHUNK_SECONDS : options.chunkSeconds;
  const duration = await durationOf(env.ffprobePath, videoPath);
  const plan = chunkPlanOf(duration, chunkSeconds);
  const all: TimedText[] = [];
  let language = options.language === undefined ? '' : options.language;

  for (let i = 0; i < plan.length; i += 1) {
    if (options.signal && options.signal.aborted) break;
    // Sequential on purpose: whisper already saturates the GPU, so running
    // chunks in parallel would not finish the early ones any sooner — and the
    // early ones are the cues the viewer needs first.
    // eslint-disable-next-line no-await-in-loop
    const chunk = await transcribeChunk(
      videoPath, env, plan[i].start, plan[i].length, language, options,
    );
    // Let the first chunk settle the language, then reuse it: faster, and it
    // stops one quiet chunk being detected as a different language.
    if (!language && chunk.language) language = chunk.language;
    all.push(...chunk.cues);
    if (options.onCues) {
      // Keep chunk delivery ordered. In particular, callers may need to create
      // a subtitle track before the next chunk can be appended to it.
      // eslint-disable-next-line no-await-in-loop
      await options.onCues(chunk.cues, { language, done: i + 1, total: plan.length });
    }
  }
  return { language, cues: all };
}

/** Small stable hash so concurrent transcriptions do not share temp files. */
function hashOf(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) % 2147483647;
  }
  return hash;
}
