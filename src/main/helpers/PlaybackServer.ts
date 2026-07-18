import { createHash } from 'crypto';
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { Transform, TransformCallback } from 'stream';

const PREFIX_SIZE = 8 * 1024 * 1024;
const MAX_FILES = 8;
const VIRTUAL_MP4_EXTENSIONS = new Set(['.m4v', '.mov', '.mp4']);

const CONTENT_TYPES: { [extension: string]: string } = {
  avi: 'video/x-msvideo',
  flv: 'video/x-flv',
  m4v: 'video/mp4',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  ts: 'video/mp2t',
  webm: 'video/webm',
  wmv: 'video/x-ms-wmv',
};

export interface ByteRange {
  start: number,
  end: number,
}

interface SharedMedia {
  filePath: string,
  prefix: Promise<Buffer>,
  virtualMedia: Promise<VirtualMedia | undefined>,
  compatibility?: {
    duration: number,
    ffmpegPath: string,
  },
  activeCompatibilityProcess?: ChildProcess,
}

interface VirtualChunk {
  originalStart: number,
  originalEnd: number,
  virtualStart: number,
  virtualEnd: number,
}

export interface VirtualMedia {
  prefix: Buffer,
  size: number,
  chunks: VirtualChunk[],
}

const MP4_CONTAINER_BOXES = new Set(['mdia', 'moov', 'trak']);

function writeMp4Duration(
  buffer: Buffer,
  offset: number,
  version: number,
  timescale: number,
  duration: number,
): void {
  const value = Math.max(0, Math.round(duration * timescale));
  if (version === 1) {
    buffer.writeUInt32BE(Math.floor(value / 0x100000000), offset);
    buffer.writeUInt32BE(value % 0x100000000, offset + 4);
  } else buffer.writeUInt32BE(Math.min(value, 0xffffffff), offset);
}

// MP4 version and container variants make this parser inherently branchy.
// eslint-disable-next-line complexity
function patchMp4Boxes(
  buffer: Buffer,
  start: number,
  end: number,
  duration: number,
  initialMovieTimescale = 1000,
): void {
  let offset = start;
  let movieTimescale = initialMovieTimescale;
  while (offset + 8 <= end) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1 && offset + 16 <= end) {
      size = (buffer.readUInt32BE(offset + 8) * 0x100000000)
        + buffer.readUInt32BE(offset + 12);
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) break;

    const version = buffer[offset + headerSize];
    if (type === 'mvhd') {
      const timescaleOffset = offset + headerSize + (version === 1 ? 20 : 12);
      const durationOffset = offset + headerSize + (version === 1 ? 24 : 16);
      movieTimescale = buffer.readUInt32BE(timescaleOffset);
      writeMp4Duration(buffer, durationOffset, version, movieTimescale, duration);
    } else if (type === 'tkhd') {
      const durationOffset = offset + headerSize + (version === 1 ? 28 : 20);
      writeMp4Duration(buffer, durationOffset, version, movieTimescale, duration);
    } else if (type === 'mdhd') {
      const timescaleOffset = offset + headerSize + (version === 1 ? 20 : 12);
      const durationOffset = offset + headerSize + (version === 1 ? 24 : 16);
      const timescale = buffer.readUInt32BE(timescaleOffset);
      writeMp4Duration(buffer, durationOffset, version, timescale, duration);
    }

    if (MP4_CONTAINER_BOXES.has(type)) {
      patchMp4Boxes(buffer, offset + headerSize, offset + size, duration, movieTimescale);
    }
    offset += size;
  }
}

export function patchFragmentedMp4Duration(initSegment: Buffer, duration: number): Buffer {
  const patched = Buffer.from(initSegment);
  patchMp4Boxes(patched, 0, patched.length, duration);
  return patched;
}

class FragmentedMp4HeaderTransform extends Transform {
  private buffered = Buffer.alloc(0);

  private headerSent = false;

  constructor(private duration: number) {
    super();
  }

  public _transform(chunk: Buffer, encoding: string, callback: TransformCallback): void {
    if (this.headerSent) {
      this.push(chunk);
      callback();
      return;
    }
    this.buffered = Buffer.concat([this.buffered, chunk]);
    const moofTypeOffset = this.buffered.indexOf('moof', 4, 'ascii');
    if (moofTypeOffset < 4) {
      callback();
      return;
    }
    const moofStart = moofTypeOffset - 4;
    this.push(patchFragmentedMp4Duration(this.buffered.slice(0, moofStart), this.duration));
    this.push(this.buffered.slice(moofStart));
    this.buffered = Buffer.alloc(0);
    this.headerSent = true;
    callback();
  }

  public _flush(callback: TransformCallback): void {
    if (this.buffered.length) {
      this.push(patchFragmentedMp4Duration(this.buffered, this.duration));
    }
    callback();
  }
}

function stopCompatibilityProcess(child: ChildProcess): void {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const forceStop = setTimeout(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  }, 500);
  forceStop.unref();
}

export function isMountedMediaPath(filePath: string): boolean {
  if (process.platform === 'darwin') return filePath.indexOf('/Volumes/') === 0;
  if (process.platform === 'win32') return /^\\\\/.test(filePath);
  return false;
}

export function shouldUsePlaybackServer(filePath: string): boolean {
  return isMountedMediaPath(filePath)
    && VIRTUAL_MP4_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function compatibilityFfmpegArgs(
  filePath: string,
  start: number,
  platform = process.platform,
): string[] {
  const args = ['-v', 'error', '-nostdin'];
  if (start > 0) args.push('-ss', start.toFixed(3));
  args.push('-i', filePath, '-map', '0:v:0', '-map', '0:a?');
  if (platform === 'darwin') {
    // Electron 11 cannot decode the source file's 10-bit HEVC stream. Apple
    // VideoToolbox converts it faster than real time without first copying the
    // multi-gigabyte movie to local storage.
    args.push(
      '-c:v', 'h264_videotoolbox', '-allow_sw', '1', '-realtime', '1',
      '-profile:v', 'high', '-level:v', '5.1', '-pix_fmt', 'yuv420p',
      '-b:v', '16M', '-maxrate', '24M', '-bufsize', '32M',
    );
  } else {
    args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-crf', '20');
  }
  args.push(
    '-c:a', 'aac', '-b:a', '256k',
    '-sn', '-dn', '-map_chapters', '-1',
    '-max_muxing_queue_size', '4096',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-frag_duration', '1000000',
    '-f', 'mp4', 'pipe:1',
  );
  return args;
}

export function parseByteRange(
  header: string | undefined,
  size: number,
): ByteRange | null | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) return null;

  if (!match[1]) {
    const suffixLength = parseInt(match[2], 10);
    if (!suffixLength) return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = parseInt(match[1], 10);
  if (!Number.isFinite(start) || start >= size) return null;
  const requestedEnd = match[2] ? parseInt(match[2], 10) : size - 1;
  if (!Number.isFinite(requestedEnd) || requestedEnd < start) return null;
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function contentType(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).slice(1).toLowerCase()]
    || 'application/octet-stream';
}

function readPrefix(filePath: string): Promise<Buffer> {
  return new Promise((resolve) => {
    fs.open(filePath, 'r', (openError, fd) => {
      if (openError) {
        resolve(Buffer.alloc(0));
        return;
      }
      fs.fstat(fd, (statError, stat) => {
        if (statError) {
          fs.close(fd, () => resolve(Buffer.alloc(0)));
          return;
        }
        const buffer = Buffer.alloc(Math.min(PREFIX_SIZE, stat.size));
        fs.read(fd, buffer, 0, buffer.length, 0, (readError, bytesRead) => {
          fs.close(fd, () => resolve(readError ? Buffer.alloc(0) : buffer.slice(0, bytesRead)));
        });
      });
    });
  });
}

function findMoovBounds(buffer: Buffer): { start: number, end: number } | undefined {
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (size < 8 || offset + size > buffer.length) return undefined;
    if (type === 'moov') return { start: offset + 8, end: offset + size };
    offset += size;
  }
  return undefined;
}

export function buildVirtualMp4(prefix: Buffer, fileSize: number): VirtualMedia | undefined {
  const moov = findMoovBounds(prefix);
  if (!moov) return undefined;

  const entries: { position: number, offset: number }[] = [];
  for (let offset = moov.start + 4; offset + 12 <= moov.end; offset += 1) {
    if (prefix.toString('ascii', offset, offset + 4) === 'stco') {
      const boxStart = offset - 4;
      const size = prefix.readUInt32BE(boxStart);
      const count = prefix.readUInt32BE(offset + 8);
      if (size === 16 + (count * 4) && boxStart + size <= moov.end) {
        for (let index = 0; index < count; index += 1) {
          const position = offset + 12 + (index * 4);
          entries.push({ position, offset: prefix.readUInt32BE(position) });
        }
        offset = boxStart + size - 1;
      }
    }
  }

  const offsets = entries.map(entry => entry.offset).sort((left, right) => left - right);
  if (offsets.length < 2 || new Set(offsets).size !== offsets.length) return undefined;
  if (offsets.some(offset => offset < 8 || offset >= fileSize)) return undefined;

  let validatedHeaders = 0;
  let invalidHeader = false;
  offsets.forEach((offset, index) => {
    const headerStart = offset - 8;
    if (headerStart + 8 > prefix.length) return;
    const nextHeaderStart = index + 1 < offsets.length ? offsets[index + 1] - 8 : fileSize;
    if (prefix.toString('ascii', headerStart + 4, headerStart + 8) !== 'mdat'
      || prefix.readUInt32BE(headerStart) !== nextHeaderStart - headerStart) {
      invalidHeader = true;
      return;
    }
    validatedHeaders += 1;
  });
  if (invalidHeader || validatedHeaders < 2) return undefined;

  const firstHeaderStart = offsets[0] - 8;
  const virtualSize = fileSize - (8 * (offsets.length - 1));
  const virtualMdatSize = virtualSize - firstHeaderStart;
  if (virtualMdatSize < 8 || virtualMdatSize > 0xffffffff) return undefined;

  const adjustedOffsets = new Map<number, number>();
  offsets.forEach((offset, index) => adjustedOffsets.set(offset, offset - (8 * index)));
  const virtualPrefix = Buffer.from(prefix.slice(0, offsets[0]));
  entries.forEach(({ position, offset }) => {
    const adjusted = adjustedOffsets.get(offset);
    if (adjusted !== undefined) virtualPrefix.writeUInt32BE(adjusted, position);
  });
  virtualPrefix.writeUInt32BE(virtualMdatSize, firstHeaderStart);

  const chunks = offsets.map((originalStart, index) => {
    const originalEnd = index + 1 < offsets.length ? offsets[index + 1] - 9 : fileSize - 1;
    const virtualStart = originalStart - (8 * index);
    return {
      originalStart,
      originalEnd,
      virtualStart,
      virtualEnd: virtualStart + (originalEnd - originalStart),
    };
  });
  return { prefix: virtualPrefix, size: virtualSize, chunks };
}

export class PlaybackServer {
  private server?: http.Server;

  private starting?: Promise<number>;

  private port = 0;

  private files = new Map<string, SharedMedia>();

  public async urlFor(filePath: string): Promise<string> {
    const token = createHash('sha1').update(filePath).digest('hex');
    const prefix = readPrefix(filePath);
    const virtualMedia = Promise.all([
      prefix,
      fs.promises.stat(filePath),
    ]).then(([buffer, stat]) => buildVirtualMp4(buffer, stat.size))
      .catch(() => undefined);
    this.files.delete(token);
    this.files.set(token, { filePath, prefix, virtualMedia });
    while (this.files.size > MAX_FILES) {
      const oldest = this.files.keys().next();
      if (!oldest.done) this.files.delete(oldest.value);
    }
    const port = await this.start();
    return `http://127.0.0.1:${port}/media/${token}/${encodeURIComponent(path.basename(filePath))}`;
  }

  public async compatibilityUrlFor(
    filePath: string,
    duration: number,
    ffmpegPath: string,
  ): Promise<string> {
    const token = createHash('sha1').update(`compatibility\u0000${filePath}`).digest('hex');
    const existing = this.files.get(token);
    if (existing && existing.activeCompatibilityProcess
      && existing.activeCompatibilityProcess.exitCode === null) {
      stopCompatibilityProcess(existing.activeCompatibilityProcess);
    }
    this.files.delete(token);
    this.files.set(token, {
      filePath,
      prefix: Promise.resolve(Buffer.alloc(0)),
      virtualMedia: Promise.resolve(undefined),
      compatibility: { duration, ffmpegPath },
    });
    while (this.files.size > MAX_FILES) {
      const oldest = this.files.keys().next();
      if (!oldest.done) this.files.delete(oldest.value);
    }
    const port = await this.start();
    return `http://127.0.0.1:${port}/compat/${token}/${encodeURIComponent(path.basename(filePath))}.mp4?start=0`;
  }

  public close(): Promise<void> {
    this.files.forEach((media) => {
      if (media.activeCompatibilityProcess
        && media.activeCompatibilityProcess.exitCode === null) {
        stopCompatibilityProcess(media.activeCompatibilityProcess);
      }
    });
    if (!this.server) return Promise.resolve();
    const server = this.server;
    this.server = undefined;
    this.starting = undefined;
    this.port = 0;
    return new Promise(resolve => server.close(() => resolve()));
  }

  private start(): Promise<number> {
    if (this.port) return Promise.resolve(this.port);
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      const server = http.createServer((request, response) => {
        this.handle(request, response);
      });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        this.port = typeof address === 'object' && address ? address.port : 0;
        this.server = server;
        server.unref();
        resolve(this.port);
      });
    });
    return this.starting;
  }

  // Range, virtual MP4, and compatibility streams share this one local endpoint.
  // eslint-disable-next-line complexity
  private async handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const compatibilityMatch = /^\/compat\/([a-f0-9]{40})\//.exec(request.url || '');
    const match = compatibilityMatch || /^\/media\/([a-f0-9]{40})\//.exec(request.url || '');
    const media = match ? this.files.get(match[1]) : undefined;
    if (!media) {
      response.writeHead(404);
      response.end();
      return;
    }

    if (compatibilityMatch && media.compatibility) {
      this.sendCompatibility(request, response, media);
      return;
    }

    try {
      const stat = await fs.promises.stat(media.filePath);
      const virtualMedia = await media.virtualMedia;
      const mediaSize = virtualMedia ? virtualMedia.size : stat.size;
      const range = parseByteRange(request.headers.range, mediaSize);
      if (range === null) {
        response.writeHead(416, { 'Content-Range': `bytes */${mediaSize}` });
        response.end();
        return;
      }
      const start = range ? range.start : 0;
      const end = range ? range.end : mediaSize - 1;
      const headers = {
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range',
        'Cache-Control': 'no-store',
        'Content-Length': end - start + 1,
        'Content-Type': contentType(media.filePath),
      };
      if (range) headers['Content-Range'] = `bytes ${start}-${end}/${mediaSize}`;
      response.writeHead(range ? 206 : 200, headers);
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      if (virtualMedia) await this.sendVirtual(media.filePath, virtualMedia, start, end, response);
      else await this.send(media, start, end, response);
    } catch (error) {
      if (!response.headersSent) response.writeHead(404);
      response.end();
    }
  }

  private sendCompatibility(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    media: SharedMedia,
  ): void {
    const { compatibility } = media;
    if (!compatibility) {
      response.writeHead(404);
      response.end();
      return;
    }
    const parsedUrl = new URL(request.url || '/', 'http://127.0.0.1');
    const requestedStart = Number(parsedUrl.searchParams.get('start'));
    const start = Number.isFinite(requestedStart)
      ? Math.max(0, Math.min(requestedStart, compatibility.duration)) : 0;
    response.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      'Content-Type': 'video/mp4',
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }

    if (media.activeCompatibilityProcess
      && media.activeCompatibilityProcess.exitCode === null) {
      stopCompatibilityProcess(media.activeCompatibilityProcess);
    }

    const args = compatibilityFfmpegArgs(media.filePath, start);
    const child = spawn(compatibility.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    media.activeCompatibilityProcess = child;
    const headerTransform = new FragmentedMp4HeaderTransform(compatibility.duration);
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 8192) stderr += chunk.toString();
    });
    child.once('error', error => response.destroy(error));
    child.once('exit', (code) => {
      if (media.activeCompatibilityProcess === child) {
        media.activeCompatibilityProcess = undefined;
      }
      if (code && !response.destroyed) {
        response.destroy(new Error(stderr || `ffmpeg exited with code ${code}`));
      }
    });
    response.once('close', () => {
      stopCompatibilityProcess(child);
    });
    child.stdout.pipe(headerTransform).pipe(response);
  }

  private async send(
    media: SharedMedia,
    requestedStart: number,
    end: number,
    response: http.ServerResponse,
  ): Promise<void> {
    let start = requestedStart;
    const prefix = await media.prefix;
    const prefixEnd = Math.min(end, prefix.length - 1);
    if (start <= prefixEnd) {
      const chunk = prefix.slice(start, prefixEnd + 1);
      start = prefixEnd + 1;
      if (start > end) {
        response.end(chunk);
        return;
      }
      if (!response.write(chunk)) {
        await new Promise(resolve => response.once('drain', resolve));
      }
    }

    const stream = fs.createReadStream(media.filePath, {
      start,
      end,
      highWaterMark: 1024 * 1024,
    });
    stream.on('error', error => response.destroy(error));
    stream.pipe(response);
  }

  private async sendVirtual(
    filePath: string,
    media: VirtualMedia,
    requestedStart: number,
    end: number,
    response: http.ServerResponse,
  ): Promise<void> {
    let start = requestedStart;
    const prefixEnd = Math.min(end, media.prefix.length - 1);
    if (start <= prefixEnd) {
      const chunk = media.prefix.slice(start, prefixEnd + 1);
      start = prefixEnd + 1;
      if (start > end) {
        response.end(chunk);
        return;
      }
      if (!response.write(chunk)) {
        const drained = await this.waitForDrain(response);
        if (!drained) return;
      }
    }

    let chunkIndex = this.findVirtualChunk(media.chunks, start);
    while (start <= end && chunkIndex < media.chunks.length && !response.destroyed) {
      const chunk = media.chunks[chunkIndex];
      if (start < chunk.virtualStart || start > chunk.virtualEnd) break;
      const virtualEnd = Math.min(end, chunk.virtualEnd);
      const originalStart = chunk.originalStart + (start - chunk.virtualStart);
      const originalEnd = originalStart + (virtualEnd - start);
      const completed = await this.pipeRange(filePath, originalStart, originalEnd, response);
      if (!completed) return;
      start = virtualEnd + 1;
      chunkIndex += 1;
    }
    if (!response.destroyed) response.end();
  }

  private findVirtualChunk(chunks: VirtualChunk[], position: number): number {
    let low = 0;
    let high = chunks.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (position < chunks[middle].virtualStart) high = middle - 1;
      else if (position > chunks[middle].virtualEnd) low = middle + 1;
      else return middle;
    }
    return low;
  }

  private waitForDrain(response: http.ServerResponse): Promise<boolean> {
    return new Promise((resolve) => {
      const onDrain = () => {
        response.removeListener('close', onClose);
        resolve(true);
      };
      const onClose = () => {
        response.removeListener('drain', onDrain);
        resolve(false);
      };
      response.once('drain', onDrain);
      response.once('close', onClose);
    });
  }

  private pipeRange(
    filePath: string,
    start: number,
    end: number,
    response: http.ServerResponse,
  ): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const stream = fs.createReadStream(filePath, {
        start,
        end,
        highWaterMark: 1024 * 1024,
      });
      const cleanup = () => response.removeListener('close', onClose);
      const onClose = () => {
        stream.destroy();
        resolve(false);
      };
      response.once('close', onClose);
      stream.once('error', (error) => {
        cleanup();
        if (response.destroyed) resolve(false);
        else reject(error);
      });
      stream.once('end', () => {
        cleanup();
        resolve(true);
      });
      stream.pipe(response, { end: false });
    });
  }
}
