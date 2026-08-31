/**
 * Cast the playing file to a Chromecast.
 *
 * The device fetches the video over HTTP from us, so this serves the file on the
 * LAN (with range support, or the TV cannot seek) alongside a WebVTT track for
 * the AI subtitles, then points the device at those URLs.
 *
 * Direct play is used for known-compatible files. Other supported containers
 * and codecs are normalized to an MP4 with H.264/AAC before the TV fetches it.
 *
 * NOTE: no `?.`/`??` — webpack 4 cannot parse them.
 */

import http from 'http';
import fs from 'fs';
import os from 'os';
import { EventEmitter } from 'events';
import { extname, basename, join } from 'path';
import { CastDevice, CastMedia } from './CastDevice';
import { discoverWithKnown, CastDeviceInfo } from './CastDiscovery';
import { runMediaBinary } from '../ffmpeg';

/** Containers the Default Media Receiver will accept. */
const CONTENT_TYPES: { [ext: string]: string } = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  ts: 'video/mp2t',
  mov: 'video/mp4',
};

export interface CastCue { start: number, end: number, text: string }

interface CastProbeStream {
  codec_type?: string;
  codec_name?: string;
}

interface CastProbe {
  streams?: CastProbeStream[];
}

interface CastSource {
  filePath: string;
  contentType: string;
  extension: string;
  cleanupDir?: string;
}

const DIRECT_VIDEO_CODECS = new Set(['h264', 'vp8', 'vp9']);
const DIRECT_AUDIO_CODECS = new Set(['aac', 'mp3']);

function codecOf(stream: CastProbeStream | undefined): string {
  return stream && stream.codec_name ? stream.codec_name.toLowerCase() : '';
}

/**
 * The Default Media Receiver accepts only a small subset of the codecs and
 * containers that SPlayer can play locally. In particular, a video can start
 * while a DTS/AC-3/TrueHD audio stream is silently discarded. Keep direct play
 * for known-good combinations and normalize everything else to MP4/H.264/AAC.
 */
export function canDirectCast(filePath: string, probe: CastProbe): boolean {
  const extension = extname(filePath).toLowerCase();
  const streams = probe.streams || [];
  const video = streams.find(stream => stream.codec_type === 'video');
  const audio = streams.find(stream => stream.codec_type === 'audio');
  const videoCodec = codecOf(video);
  const audioCodec = codecOf(audio);
  if (!video || !DIRECT_VIDEO_CODECS.has(videoCodec)) return false;

  if (extension === '.webm') {
    return (videoCodec === 'vp8' || videoCodec === 'vp9')
      && (!audioCodec || audioCodec === 'opus' || audioCodec === 'vorbis');
  }

  const mp4Family = ['.mp4', '.m4v', '.mov'].includes(extension);
  const isTransportStream = extension === '.ts';
  if (!mp4Family && !isTransportStream) return false;
  return !audioCodec || DIRECT_AUDIO_CODECS.has(audioCodec);
}

async function probeCastSource(filePath: string): Promise<CastProbe> {
  const { stdout } = await runMediaBinary('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,codec_name',
    '-of', 'json',
    filePath,
  ]);
  return JSON.parse(stdout) as CastProbe;
}

async function removeCastDirectory(directory: string): Promise<void> {
  try {
    await fs.promises.rm(directory, { recursive: true, force: true });
  } catch (error) {
    // Cleanup must never hide the useful probe/transcode error.
  }
}

async function prepareCastSource(filePath: string): Promise<CastSource> {
  const originalContentType = contentTypeOf(filePath);
  if (!originalContentType) {
    throw new Error(`unsupported-container:${extname(filePath).slice(1) || '?'}`);
  }

  const probe = await probeCastSource(filePath);
  if (canDirectCast(filePath, probe)) {
    return {
      filePath,
      contentType: originalContentType,
      extension: extname(filePath),
    };
  }

  const directory = await fs.promises.mkdtemp(join(os.tmpdir(), 'splayer-cast-'));
  const outputPath = join(directory, 'media.mp4');
  const video = (probe.streams || []).find(stream => stream.codec_type === 'video');
  const videoCodec = codecOf(video);
  const args = [
    '-y', '-v', 'error', '-i', filePath,
    '-map', '0:v:0', '-map', '0:a:0?',
  ];
  if (videoCodec === 'h264') {
    // Most of the work here is audio-only, so DTS/AC-3 files start quickly and
    // do not needlessly lose the source video quality.
    args.push('-c:v', 'copy');
  } else {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p');
  }
  args.push(
    '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
    '-movflags', '+faststart', outputPath,
  );

  try {
    await runMediaBinary('ffmpeg', args);
    return {
      filePath: outputPath,
      contentType: 'video/mp4',
      extension: '.mp4',
      cleanupDir: directory,
    };
  } catch (error) {
    await removeCastDirectory(directory);
    throw error;
  }
}

function firstLanIp(): string | undefined {
  const interfaces = os.networkInterfaces();
  const names = Object.keys(interfaces);
  for (let i = 0; i < names.length; i += 1) {
    const addresses = interfaces[names[i]];
    for (let j = 0; j < addresses.length; j += 1) {
      const address = addresses[j];
      // The TV has to reach us, so loopback and IPv6 are no use here.
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return undefined;
}

function vttTime(seconds: number): string {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.floor((total - Math.floor(total)) * 1000);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

/** Chromecast renders sidecar WebVTT; our cues live in memory, so build one. */
export function cuesToVtt(cues: CastCue[]): string {
  const body = cues.map((cue, i) => `${i + 1}\n${vttTime(cue.start)} --> ${vttTime(cue.end)}\n${cue.text}`);
  return `WEBVTT\n\n${body.join('\n\n')}\n`;
}

export function contentTypeOf(filePath: string): string | undefined {
  return CONTENT_TYPES[extname(filePath).slice(1).toLowerCase()];
}

export interface CastStatus {
  casting: boolean;
  currentTime: number;
  duration: number;
  paused: boolean;
}

export class CastService extends EventEmitter {
  private server?: http.Server;

  private device?: CastDevice;

  private filePath = '';

  private vtt = '';

  private port = 0;

  private knownDevices: CastDeviceInfo[] = [];

  private refreshing?: Promise<CastDeviceInfo[]>;

  private statusTimer?: NodeJS.Timeout;

  private statusBusy = false;

  private castCleanupDir?: string;

  private lastStatus: CastStatus = {
    casting: false, currentTime: 0, duration: 0, paused: true,
  };

  /** One scan at a time; callers share the in-flight one. */
  private refresh(timeout?: number): Promise<CastDeviceInfo[]> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = discoverWithKnown(this.knownDevices, timeout)
      .then((devices) => {
        this.knownDevices = devices;
        this.refreshing = undefined;
        return devices;
      })
      .catch(() => {
        this.refreshing = undefined;
        return this.knownDevices;
      });
    return this.refreshing;
  }

  /**
   * Devices to offer the user, without making them wait after the first scan.
   *
   * A scan has to sit out the whole mDNS window -- seconds -- so blocking on one
   * per click means the picker takes seconds to appear every single time. Answer
   * from what we already know and refresh behind the scenes. Discovery begins
   * only when the user opens the picker; an idle player must not keep a network
   * scanner or subprocess lifecycle alive.
   */
  public async listDevices(timeout?: number): Promise<CastDeviceInfo[]> {
    if (this.knownDevices.length) {
      this.refresh(timeout); // deliberately not awaited
      return this.knownDevices;
    }
    return this.refresh(timeout);
  }

  private serve(): Promise<number> {
    if (this.server && this.port) return Promise.resolve(this.port);
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.onRequest(req, res));
      server.on('error', reject);
      // Port 0: let the OS pick. Bound on all interfaces so the TV can reach it.
      server.listen(0, '0.0.0.0', () => {
        const address = server.address();
        this.port = typeof address === 'object' && address ? address.port : 0;
        this.server = server;
        resolve(this.port);
      });
    });
  }

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url || '';
    if (url.indexOf('/subtitle.vtt') === 0) {
      res.writeHead(200, {
        'Content-Type': 'text/vtt; charset=utf-8',
        'Access-Control-Allow-Origin': '*', // the receiver fetches this cross-origin
        'Content-Length': Buffer.byteLength(this.vtt),
      });
      res.end(this.vtt);
      return;
    }
    if (url.indexOf('/video') !== 0 || !this.filePath) {
      res.writeHead(404);
      res.end();
      return;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.filePath);
    } catch (e) {
      res.writeHead(404);
      res.end();
      return;
    }
    const type = contentTypeOf(this.filePath) || 'video/mp4';
    const range = req.headers.range;
    if (range) {
      // Without range support the device cannot seek, and some receivers refuse
      // to start at all.
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      const start = match && match[1] ? parseInt(match[1], 10) : 0;
      const end = match && match[2] ? parseInt(match[2], 10) : stat.size - 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': type,
        'Access-Control-Allow-Origin': '*',
      });
      fs.createReadStream(this.filePath, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(this.filePath).pipe(res);
  }

  /**
   * Serve `filePath` and play it on `target`. Rejects when the container is one
   * the receiver cannot decode, so the failure is explained here rather than as
   * a blank screen on the TV.
   */
  public async cast(
    target: CastDeviceInfo,
    filePath: string,
    cues: CastCue[] = [],
    currentTime = 0,
    volume = 1,
  ): Promise<void> {
    const ip = firstLanIp();
    if (!ip) throw new Error('no-lan-address');

    this.stopDevice();
    this.releaseCastSource();
    const source = await prepareCastSource(filePath);
    this.castCleanupDir = source.cleanupDir;
    this.filePath = source.filePath;
    this.vtt = cues.length ? cuesToVtt(cues) : '';
    let port: number;
    try {
      port = await this.serve();
    } catch (error) {
      this.releaseCastSource();
      throw error;
    }
    const base = `http://${ip}:${port}`;

    const device = new CastDevice(target.ip || target.host, target.port);
    this.device = device;
    // CastDevice reports socket failures through both its promise and its
    // EventEmitter. Keep the latter from becoming an uncaught process error.
    device.on('error', () => {});
    device.on('close', () => {
      if (this.device !== device) return;
      this.device = undefined;
      this.releaseCastSource();
      this.stopStatusPolling();
      this.publishStatus({
        casting: false,
        currentTime: this.lastStatus.currentTime,
        duration: this.lastStatus.duration,
        paused: true,
      });
    });
    const media: CastMedia = {
      url: `${base}/video${source.extension}`,
      contentType: source.contentType,
      title: basename(filePath),
      currentTime,
    };
    if (this.vtt) {
      media.subtitleUrl = `${base}/subtitle.vtt`;
      media.subtitleLanguage = 'zh-CN';
    }
    try {
      await device.connect();
      await device.load(media);
      device.setVolume(Math.max(0, Math.min(1, volume)));
    } catch (error) {
      this.stopDevice();
      this.releaseCastSource();
      throw error;
    }
    this.publishStatus({
      casting: true, currentTime, duration: 0, paused: false,
    });
    this.startStatusPolling();
  }

  private publishStatus(status: CastStatus): void {
    this.lastStatus = status;
    this.emit('status', status);
  }

  private startStatusPolling(): void {
    this.stopStatusPolling();
    const poll = async () => {
      if (!this.device || this.statusBusy) return;
      const device = this.device;
      this.statusBusy = true;
      try {
        const status = await device.getStatus();
        if (this.device === device && status) {
          this.publishStatus(Object.assign({ casting: true }, status));
        }
      } catch (error) {
        // A transient status timeout must not tear down an otherwise live cast.
      } finally {
        this.statusBusy = false;
      }
    };
    poll();
    this.statusTimer = setInterval(poll, 1000);
  }

  private stopStatusPolling(): void {
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = undefined;
    }
    this.statusBusy = false;
  }

  public play(): void {
    if (!this.device) return;
    this.device.play();
    this.publishStatus(Object.assign({}, this.lastStatus, { casting: true, paused: false }));
  }

  public pause(): void {
    if (!this.device) return;
    this.device.pause();
    this.publishStatus(Object.assign({}, this.lastStatus, { casting: true, paused: true }));
  }

  public seek(seconds: number): void {
    if (!this.device) return;
    this.device.seek(seconds);
    this.publishStatus(Object.assign({}, this.lastStatus, { casting: true, currentTime: seconds }));
  }

  public setVolume(level: number): void {
    if (this.device) this.device.setVolume(Math.max(0, Math.min(1, level)));
  }

  private stopDevice(): void {
    if (this.device) {
      const device = this.device;
      this.device = undefined;
      device.stop();
    }
    this.stopStatusPolling();
  }

  private releaseCastSource(): void {
    const directory = this.castCleanupDir;
    this.castCleanupDir = undefined;
    if (directory) removeCastDirectory(directory);
  }

  /** Stop casting and release the port. */
  public stop(): void {
    this.stopDevice();
    this.releaseCastSource();
    if (this.server) {
      try { this.server.close(); } catch (e) { /* not listening */ }
      this.server = undefined;
      this.port = 0;
    }
    this.publishStatus({
      casting: false,
      currentTime: this.lastStatus.currentTime,
      duration: this.lastStatus.duration,
      paused: true,
    });
  }

  public get casting(): boolean { return !!this.device; }
}

export const castService = new CastService();
