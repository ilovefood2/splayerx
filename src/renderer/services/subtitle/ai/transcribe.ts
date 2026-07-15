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
  modelPath?: string;
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

function findModel(searchDirs: string[]): string | undefined {
  for (let i = 0; i < searchDirs.length; i += 1) {
    for (let j = 0; j < MODEL_NAMES.length; j += 1) {
      const candidate = join(searchDirs[i], MODEL_NAMES[j]);
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
  const modelPath = findModel(modelDirs);

  const missing: TranscribeTool[] = [];
  if (!whisperPath) missing.push('whisper');
  if (!ffmpegPath) missing.push('ffmpeg');
  if (!modelPath) missing.push('model');

  return {
    ok: missing.length === 0, whisperPath, ffmpegPath, modelPath, missing,
  };
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
    cues.push({ start: offsets.from / 1000, end: offsets.to / 1000, text });
  });
  return cues;
}

/**
 * Transcribe a video's audio into timed cues.
 *
 * Extracts 16 kHz mono PCM first, which is what whisper wants; feeding it the
 * original container makes it resample internally and is much slower.
 */
export async function transcribeVideo(
  videoPath: string,
  env: TranscribeEnvironment,
  options: {
    tmpDir: string,
    onProgress?: (percent: number) => void,
    signal?: AbortSignal,
    /** Cap on decoding threads; whisper defaults to 4. */
    threads?: number,
  },
): Promise<TranscribeResult> {
  if (!env.ok || !env.whisperPath || !env.ffmpegPath || !env.modelPath) {
    throw new Error(`transcribe environment incomplete: missing ${env.missing.join(', ')}`);
  }
  const stamp = `splayer-whisper-${Math.abs(hashOf(videoPath))}`;
  const wavPath = join(options.tmpDir, `${stamp}.wav`);
  const outPrefix = join(options.tmpDir, stamp);
  const jsonPath = `${outPrefix}.json`;

  try {
    await run(env.ffmpegPath, [
      '-y', '-i', videoPath,
      '-vn', // no video
      '-ac', '1', // mono
      '-ar', '16000', // whisper's native rate
      '-c:a', 'pcm_s16le',
      wavPath,
    ], { signal: options.signal });

    const threads = options.threads === undefined ? 4 : options.threads;
    await run(env.whisperPath, [
      '-m', env.modelPath,
      '-f', wavPath,
      '-l', 'auto', // detect the spoken language
      '-oj', // JSON output, with millisecond offsets
      '-of', outPrefix,
      '-t', String(threads),
      '-pp', // progress on stderr
    ], {
      signal: options.signal,
      onStderr: (chunk) => {
        const percent = parseProgress(chunk);
        if (percent !== undefined && options.onProgress) options.onProgress(percent);
      },
    });

    if (!existsSync(jsonPath)) throw new Error('whisper produced no output');
    const json = JSON.parse(readFileSync(jsonPath, 'utf8')) as WhisperJson;
    const result = json.result;
    return {
      language: result && result.language ? result.language : '',
      cues: parseWhisperCues(json),
    };
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

/** Small stable hash so concurrent transcriptions do not share temp files. */
function hashOf(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) % 2147483647;
  }
  return hash;
}
