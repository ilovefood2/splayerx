import { createHash } from 'crypto';
import { app, ipcMain, IpcMainEvent } from 'electron';
import {
  existsSync, mkdirSync, readFile, renameSync, statSync, unlinkSync,
} from 'fs';
import path from 'path';
import { runMediaBinary } from './ffmpeg';
import { isMountedMediaPath, PlaybackServer } from './PlaybackServer';

function reply(event: IpcMainEvent, channel: string, ...args: unknown[]) {
  if (event.sender && !event.sender.isDestroyed()) event.reply(channel, ...args);
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

const extractedSubtitles = new Map<string, ExtractedSubtitle>();
const compatibilityTasks = new Map<string, Promise<string>>();
const playbackServer = new PlaybackServer();

function compatibilityOutputPath(videoPath: string): string {
  const stat = statSync(videoPath);
  const key = createHash('sha1')
    .update(`${videoPath}\u0000${stat.size}\u0000${stat.mtimeMs}`)
    .digest('hex');
  const directory = path.join(app.getPath('temp'), 'splayer-compat-media');
  mkdirSync(directory, { recursive: true });
  return path.join(directory, `${key}.mp4`);
}

async function preparePlaybackSource(videoPath: string): Promise<string> {
  if (path.extname(videoPath).toLowerCase() !== '.ts') {
    return isMountedMediaPath(videoPath) ? playbackServer.urlFor(videoPath) : videoPath;
  }
  if (!existsSync(videoPath)) throw new Error('File does not exist.');

  const outputPath = compatibilityOutputPath(videoPath);
  if (existsSync(outputPath)) return outputPath;
  const runningTask = compatibilityTasks.get(outputPath);
  if (runningTask) return runningTask;

  const partialPath = `${outputPath}.${process.pid}.partial.mp4`;
  const task = (async () => {
    try {
      await runMediaBinary('ffmpeg', [
        '-y', '-v', 'error', '-i', videoPath,
        '-map', '0:v:0', '-map', '0:a?',
        '-c', 'copy', '-movflags', '+faststart', partialPath,
      ]);
      renameSync(partialPath, outputPath);
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
  ipcMain.removeHandler('prepare-playback-source');
  ipcMain.handle('prepare-playback-source', (event, videoPath: string) => (
    preparePlaybackSource(videoPath)
  ));

  ipcMain.on('media-info-request', async (event, videoPath) => {
    if (!existsSync(videoPath)) {
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
    if (!existsSync(videoPath)) {
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
    if (!existsSync(videoPath)) {
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
