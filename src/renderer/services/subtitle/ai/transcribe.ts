/**
 * Local speech-to-subtitle via whisper.cpp.
 *
 * For a video with no usable subtitle track there is nothing to translate, so we
 * make one: extract the audio with ffmpeg, transcribe it with whisper-cli, and
 * hand the cues to the normal AI translation pipeline.
 *
 * Both binaries come from the user's own install (Homebrew) rather than being
 * bundled. A packaged .app does NOT inherit the shell PATH, so everything is
 * resolved by absolute path and reported precisely when missing.
 *
 * NOTE: explicit `=== undefined` checks rather than `??`/`?.` — see ollama.ts.
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync, unlinkSync } from 'fs';
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
  /** Which pieces are missing, so the UI can name them exactly. */
  missing: TranscribeTool[];
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

/**
 * Locate everything transcription needs.
 * `userDataPath` is passed in rather than imported so this module stays testable
 * and free of electron.
 */
export function checkTranscribeEnvironment(
  userDataPath?: string,
  home?: string,
): TranscribeEnvironment {
  const modelDirs: string[] = [];
  if (userDataPath) modelDirs.push(join(userDataPath, 'whisper'));
  if (home) {
    modelDirs.push(join(home, 'Library', 'Application Support', 'SPlayer', 'whisper'));
    modelDirs.push(join(home, '.cache', 'whisper'));
  }
  modelDirs.push('/opt/homebrew/share/whisper-cpp');

  const whisperPath = findBinary(WHISPER_NAMES);
  const ffmpegPath = findBinary(['ffmpeg']);
  // ffprobe ships with ffmpeg; we need it to know how long the video is.
  const ffprobePath = findBinary(['ffprobe']);
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

function run(
  command: string,
  args: string[],
  options: { onStderr?: (chunk: string) => void, signal?: AbortSignal } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stderr = '';
    child.stderr.on('data', (data: Buffer) => {
      const text = data.toString();
      // whisper-cli reports progress on stderr; keep only the tail for errors.
      stderr = (stderr + text).slice(-4000);
      if (options.onStderr) options.onStderr(text);
    });
    child.on('error', reject);
    if (options.signal) {
      options.signal.addEventListener('abort', () => child.kill(), { once: true });
    }
    child.on('close', (code) => {
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
  onCues?: (cues: TimedText[], info: { language: string, done: number, total: number }) => void;
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
      options.onCues(chunk.cues, { language, done: i + 1, total: plan.length });
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
