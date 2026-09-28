import { createHash } from 'crypto';
import { app, ipcMain, IpcMainEvent } from 'electron';
import {
  existsSync, mkdirSync, readFile, renameSync, unlinkSync, promises as fsPromises,
} from 'fs';
import path from 'path';
import { mediaBinaryPath, runMediaBinary } from './ffmpeg';

// existsSync/statSync block the main process for the full duration of the
// syscall. On a laggy network mount (/Volumes/... over SMB) that can be seconds,
// during which even window dragging — an ipcMain handler — freezes. Any check on
// a user-supplied video path (which may be on such a mount) must be async; the
// synchronous variants are kept only for our own local temp/cache files.
async function pathExists(target: string): Promise<boolean> {
  try {
    await fsPromises.access(target);
    return true;
  } catch (error) {
    return false;
  }
}
import {
  isHdrColorMetadata, isMountedMediaPath, PlaybackServer, shouldUsePlaybackServer,
} from './PlaybackServer';

function reply(event: IpcMainEvent, channel: string, ...args: unknown[]) {
  if (!event.sender || event.sender.isDestroyed()) return;
  try {
    // `event.reply()` targets the originating frame. Electron 43 can dispose
    // that frame while keeping its WebContents alive during window teardown,
    // which produces an uncaught WebFrameMain error. These request channels
    // are window-scoped, so replying through WebContents is both sufficient
    // and safe across a frame navigation or shutdown.
    event.sender.send(channel, ...args);
  } catch {
    // A renderer can disappear between the isDestroyed check and reply while
    // the app is closing. The request no longer has a recipient in that case.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function scaleFilter(width: number, height: number): string {
  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));
  return `scale=${safeWidth}:${safeHeight}:force_original_aspect_ratio=decrease`;
}

interface ExtractedSubtitle {
  path: string,
  metadata: string,
}

interface MediaProbe {
  format?: { duration?: string | number },
  streams?: Array<{ [key: string]: string | undefined }>,
}

const extractedSubtitles = new Map<string, ExtractedSubtitle>();
const compatibilityTasks = new Map<string, Promise<string>>();
const playbackServer = new PlaybackServer();
let playbackServerShutdownRegistered = false;

function compatibilityDirectory(): string {
  return path.join(app.getPath('temp'), 'splayer-compat-media');
}

// Bump when the rules for which files get remuxed change. Copies made under
// older rules (e.g. MPEG-2 video Chromium cannot show) are then never reused;
// cache pruning deletes them.
const REMUX_CACHE_VERSION = 2;

async function compatibilityOutputPath(videoPath: string): Promise<string> {
  const stat = await fsPromises.stat(videoPath);
  const key = createHash('sha1')
    .update(`${REMUX_CACHE_VERSION}\u0000${videoPath}\u0000${stat.size}\u0000${stat.mtimeMs}`)
    .digest('hex');
  const directory = compatibilityDirectory();
  mkdirSync(directory, { recursive: true });
  return path.join(directory, `${key}.mp4`);
}

// Each remuxed .ts is a full copy of the recording. Keep enough to make
// re-opening recent files instant without letting the cache grow forever.
export const COMPAT_CACHE_MAX_BYTES = 8 * 1024 * 1024 * 1024;
export const COMPAT_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Drop remux leftovers: partial files from a remux that was interrupted (app
 * quit or crashed mid-copy — nothing else ever deletes them), then completed
 * copies not used within the age limit or beyond the size budget, least
 * recently used first.
 */
export async function pruneCompatibilityCache(
  directory: string,
  {
    now = Date.now(),
    pid = process.pid,
    maxBytes = COMPAT_CACHE_MAX_BYTES,
    maxAgeMs = COMPAT_CACHE_MAX_AGE_MS,
  }: { now?: number, pid?: number, maxBytes?: number, maxAgeMs?: number } = {},
): Promise<void> {
  let names: string[];
  try {
    names = await fsPromises.readdir(directory);
  } catch {
    return; // nothing cached yet
  }
  const completed: { file: string, size: number, used: number }[] = [];
  await Promise.all(names.map(async (name) => {
    const file = path.join(directory, name);
    let stat;
    try {
      stat = await fsPromises.stat(file);
    } catch {
      return;
    }
    if (!stat.isFile()) return;
    const partial = /\.(\d+)\.partial\.mp4$/.exec(name);
    if (partial) {
      // A remux in flight belongs to this process; any other is abandoned.
      if (Number(partial[1]) !== pid) await fsPromises.unlink(file).catch(() => {});
      return;
    }
    if (name.endsWith('.mp4')) completed.push({ file, size: stat.size, used: stat.mtimeMs });
  }));
  completed.sort((left, right) => right.used - left.used);
  let kept = 0;
  await Promise.all(completed.map((entry, index) => {
    kept += entry.size;
    // The newest copy is always kept, however large: it is the one that was
    // just remuxed (or reused) and is about to be played.
    const overBudget = index > 0 && kept > maxBytes;
    if (now - entry.used > maxAgeMs || overBudget) {
      return fsPromises.unlink(entry.file).catch(() => {});
    }
    return undefined;
  }));
}

async function probeForCompatibility(videoPath: string): Promise<MediaProbe> {
  const { stdout } = await runMediaBinary('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,codec_name,color_transfer',
    '-of', 'json', videoPath,
  ]);
  return JSON.parse(stdout) as MediaProbe;
}

function probeDuration(probe: MediaProbe): number {
  const duration = Number(probe.format && probe.format.duration);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function compatibilityStreamUrl(
  videoPath: string,
  probe: MediaProbe,
  duration: number,
): Promise<string> {
  const videoStream = (probe.streams || []).find(stream => stream['codec_type'] === 'video');
  return playbackServer.compatibilityUrlFor(
    videoPath,
    duration,
    mediaBinaryPath('ffmpeg'),
    isHdrColorMetadata({
      colorTransfer: videoStream && videoStream['color_transfer'],
    }),
  );
}

const REMUX_VIDEO_CODECS = new Set(['h264', 'hevc']);
const REMUX_AUDIO_CODECS = new Set(['aac', 'mp3']);

/**
 * How to play a transport stream that has no cached remux yet.
 *
 * The lossless copy into MP4 has to finish before the first frame shows. That
 * is quick on a local disk, but on a network share it means pulling the whole
 * recording across first -- minutes for a large one, with nothing on screen.
 * And for broadcast MPEG-2 video or AC-3/MP2 audio, which Chromium cannot
 * decode, the copy would not play properly anyway. Both of those start
 * immediately, seekable, through the same compatibility encoder as .mkv.
 */
export function transportStreamPlan(videoPath: string, probe: MediaProbe): 'remux' | 'stream' {
  if (isMountedMediaPath(videoPath)) return 'stream';
  const streams = probe.streams || [];
  const codec = (stream?: { [key: string]: string | undefined }) => (
    ((stream && stream['codec_name']) || '').toLowerCase()
  );
  const video = streams.find(stream => stream['codec_type'] === 'video');
  if (!REMUX_VIDEO_CODECS.has(codec(video))) return 'stream';
  const audio = streams.filter(stream => stream['codec_type'] === 'audio');
  return audio.every(stream => REMUX_AUDIO_CODECS.has(codec(stream))) ? 'remux' : 'stream';
}

async function preparePlaybackSource(videoPath: string): Promise<string> {
  const extension = path.extname(videoPath).toLowerCase();
  if (extension === '.mkv') {
    if (!(await pathExists(videoPath))) throw new Error('File does not exist.');
    const probe = await probeForCompatibility(videoPath);
    const duration = probeDuration(probe);
    if (!duration) throw new Error('Cannot determine Matroska duration.');
    return compatibilityStreamUrl(videoPath, probe, duration);
  }
  if (extension !== '.ts') {
    return shouldUsePlaybackServer(videoPath) ? playbackServer.urlFor(videoPath) : videoPath;
  }
  if (!(await pathExists(videoPath))) throw new Error('File does not exist.');

  const outputPath = await compatibilityOutputPath(videoPath);
  if (existsSync(outputPath)) {
    // Mark it recently used so cache pruning keeps what is actually watched.
    const now = new Date();
    await fsPromises.utimes(outputPath, now, now).catch(() => {});
    return outputPath;
  }
  const runningTask = compatibilityTasks.get(outputPath);
  if (runningTask) return runningTask;

  let probe: MediaProbe | undefined;
  try {
    probe = await probeForCompatibility(videoPath);
  } catch (error) {
    // Unreadable metadata: the remux below reports the real problem.
  }
  const duration = probe ? probeDuration(probe) : 0;
  // Streaming needs the duration for its timeline; without one, copy instead.
  if (probe && duration && transportStreamPlan(videoPath, probe) === 'stream') {
    return compatibilityStreamUrl(videoPath, probe, duration);
  }
  const startedMeanwhile = compatibilityTasks.get(outputPath);
  if (startedMeanwhile) return startedMeanwhile;

  const partialPath = `${outputPath}.${process.pid}.partial.mp4`;
  const task = (async () => {
    try {
      await runMediaBinary('ffmpeg', [
        '-y', '-v', 'error', '-i', videoPath,
        '-map', '0:v:0', '-map', '0:a?',
        '-c', 'copy', '-movflags', '+faststart', partialPath,
      ]);
      renameSync(partialPath, outputPath);
      pruneCompatibilityCache(path.dirname(outputPath)).catch(() => {});
      return outputPath;
    } catch (error) {
      if (existsSync(partialPath)) unlinkSync(partialPath);
      throw error;
    } finally {
      compatibilityTasks.delete(outputPath);
    }
  })();
  compatibilityTasks.set(outputPath, task);
  return task;
}

function subtitleKey(videoPath: string, streamIndex: number) {
  return `${videoPath}\u0000${streamIndex}`;
}

async function extractTextSubtitle(
  videoPath: string,
  streamIndex: number,
  subtitlePath: string,
): Promise<ExtractedSubtitle> {
  if (path.extname(subtitlePath).toLowerCase() === '.sis') {
    throw new Error('Bitmap subtitle extraction is not available in the native ARM64 runtime.');
  }
  await runMediaBinary('ffmpeg', [
    '-y', '-v', 'error', '-i', videoPath,
    '-map', `0:${streamIndex}`, '-c:s', 'ass', '-f', 'ass', subtitlePath,
  ]);
  const payload = await new Promise<Buffer>((resolve, reject) => {
    readFile(subtitlePath, (error, data) => (error ? reject(error) : resolve(data)));
  });
  const source = payload.toString('utf8');
  const metadata = source
    .replace(/\n(Dialogue|Comment)[\s\S]*/g, '')
    .split(/\r?\n/)
    .join('\n');
  const extracted = { path: subtitlePath, metadata };
  extractedSubtitles.set(subtitleKey(videoPath, streamIndex), extracted);
  return extracted;
}

export default function registerMediaTasks() {
  if (!playbackServerShutdownRegistered) {
    playbackServerShutdownRegistered = true;
    app.once('before-quit', () => playbackServer.close());
    // Clear what earlier runs left behind; never blocks startup.
    pruneCompatibilityCache(compatibilityDirectory()).catch(() => {});
  }
  ipcMain.removeHandler('prepare-playback-source');
  ipcMain.handle('prepare-playback-source', (event, videoPath: string) => (
    preparePlaybackSource(videoPath)
  ));

  ipcMain.on('media-info-request', async (event, videoPath) => {
    if (!(await pathExists(videoPath))) {
      reply(event, 'media-info-reply', 'File does not exist.');
      return;
    }
    try {
      const { stdout } = await runMediaBinary('ffprobe', [
        '-v', 'error', '-show_format', '-show_streams', '-print_format', 'json', videoPath,
      ]);
      reply(event, 'media-info-reply', null, stdout);
    } catch (error) {
      reply(event, 'media-info-reply', errorMessage(error));
    }
  });

  ipcMain.on('snapshot-request', async (
    event, videoPath, imagePath, timeString, width, height,
  ) => {
    if (existsSync(imagePath)) {
      reply(event, 'snapshot-reply', null, imagePath);
      return;
    }
    if (!(await pathExists(videoPath))) {
      reply(event, 'snapshot-reply', 'File does not exist.');
      return;
    }
    try {
      await runMediaBinary('ffmpeg', [
        '-y', '-v', 'error', '-ss', timeString, '-i', videoPath,
        '-frames:v', '1', '-vf', scaleFilter(width, height), imagePath,
      ]);
      reply(event, 'snapshot-reply', null, imagePath);
    } catch (error) {
      reply(event, 'snapshot-reply', errorMessage(error));
    }
  });

  ipcMain.on('subtitle-metadata-request', async (
    event: IpcMainEvent, videoPath: string, streamIndex: number, subtitlePath: string,
  ) => {
    try {
      const key = subtitleKey(videoPath, streamIndex);
      const extracted = extractedSubtitles.get(key)
        || await extractTextSubtitle(videoPath, streamIndex, subtitlePath);
      reply(event, 'subtitle-metadata-reply', undefined, false, extracted.metadata);
    } catch (error) {
      reply(event, 'subtitle-metadata-reply', errorMessage(error));
    }
  });

  ipcMain.on('subtitle-cache-request', async (
    event: IpcMainEvent, videoPath: string, streamIndex: number,
  ) => {
    const extracted = extractedSubtitles.get(subtitleKey(videoPath, streamIndex));
    if (extracted && existsSync(extracted.path)) {
      reply(event, 'subtitle-cache-reply', undefined, extracted.path);
    } else {
      reply(event, 'subtitle-cache-reply', 'Subtitle metadata must be loaded first.');
    }
  });

  ipcMain.on('subtitle-stream-request', async (
    event: IpcMainEvent, videoPath: string, streamIndex: number,
  ) => {
    const extracted = extractedSubtitles.get(subtitleKey(videoPath, streamIndex));
    if (!extracted) {
      reply(event, 'subtitle-stream-reply', 'Subtitle metadata must be loaded first.');
      return;
    }
    readFile(extracted.path, (error, data) => {
      if (error) reply(event, 'subtitle-stream-reply', error.message);
      else reply(event, 'subtitle-stream-reply', undefined, data);
    });
  });

  ipcMain.on('subtitle-destroy-request', (
    event: IpcMainEvent, videoPath: string, streamIndex: number,
  ) => {
    extractedSubtitles.delete(subtitleKey(videoPath, streamIndex));
    reply(event, 'subtitle-destroy-reply');
  });

  ipcMain.on('thumbnail-request', async (
    event, videoPath, imagePath, interval, thumbnailWidth, cols,
  ) => {
    if (existsSync(imagePath)) {
      reply(event, 'thumbnail-reply', null, imagePath, videoPath);
      return;
    }
    if (!(await pathExists(videoPath))) {
      reply(event, 'thumbnail-reply', 'File does not exist.');
      return;
    }
    try {
      const safeInterval = Math.max(1, Number(interval));
      const safeWidth = Math.max(1, Math.round(Number(thumbnailWidth)));
      const safeCols = Math.max(1, Math.round(Number(cols)));
      const { stdout } = await runMediaBinary('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', videoPath,
      ]);
      const duration = Math.max(0, Number.parseFloat(stdout));
      const thumbnailCount = Math.max(1, Math.ceil(duration / safeInterval));
      const rows = Math.max(1, Math.ceil(thumbnailCount / safeCols));
      const filter = `fps=1/${safeInterval},scale=${safeWidth}:-1,tile=${safeCols}x${rows}`;
      await runMediaBinary('ffmpeg', [
        '-y', '-v', 'error', '-i', videoPath, '-frames:v', '1', '-vf', filter, imagePath,
      ]);
      reply(event, 'thumbnail-reply', null, imagePath, videoPath);
    } catch (error) {
      reply(event, 'thumbnail-reply', errorMessage(error));
    }
  });
}
