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
import { app } from 'electron';
import { pipeline } from 'stream';
import { extname, basename, join } from 'path';
import { CastDevice, CastMedia, CastPlaybackStatus } from './CastDevice';
import { discoverWithKnown, CastDeviceInfo } from './CastDiscovery';
import { runMediaBinary } from '../ffmpeg';
import { parseByteRange } from '../PlaybackServer';
import { images } from '../../../../config/fileAssociations';

/** Containers the Default Media Receiver will accept. */
const CONTENT_TYPES: { [ext: string]: string } = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  ts: 'video/mp2t',
  mov: 'video/mp4',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
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

async function probeCastSource(filePath: string, signal?: AbortSignal): Promise<CastProbe> {
  const { stdout } = await runMediaBinary('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,codec_name',
    '-of', 'json',
    filePath,
  ], { signal });
  return JSON.parse(stdout) as CastProbe;
}

/** A newer cast (or a stop) replaced this one while it was being prepared. */
export const CAST_SUPERSEDED = 'cast-superseded';

async function removeCastDirectory(directory: string): Promise<void> {
  try {
    await fs.promises.rm(directory, { recursive: true, force: true });
  } catch (error) {
    // Cleanup must never hide the useful probe/transcode error.
  }
}

async function prepareCastSource(filePath: string, signal?: AbortSignal): Promise<CastSource> {
  const extension = extname(filePath).slice(1).toLowerCase();
  if (images.includes(extension)) {
    const directType = contentTypeOf(filePath);
    if (directType) return { filePath, contentType: directType, extension: extname(filePath) };
    const directory = await fs.promises.mkdtemp(join(os.tmpdir(), 'splayer-cast-'));
    const outputPath = join(directory, 'image.png');
    try {
      await runMediaBinary('ffmpeg', [
        '-y', '-v', 'error', '-i', filePath, '-frames:v', '1', outputPath,
      ], { signal });
      return {
        filePath: outputPath, contentType: 'image/png', extension: '.png', cleanupDir: directory,
      };
    } catch (error) {
      await removeCastDirectory(directory);
      throw error;
    }
  }
  const originalContentType = contentTypeOf(filePath);
  if (!originalContentType) {
    throw new Error(`unsupported-container:${extname(filePath).slice(1) || '?'}`);
  }

  const probe = await probeCastSource(filePath, signal);
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
    // Abortable: a transcode can take minutes, and a newer cast or a stop
    // must not leave it running (and writing a copy nobody will serve).
    await runMediaBinary('ffmpeg', args, { signal });
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

function ipv4ToInt(address: string): number | undefined {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return undefined;
  }
  // eslint-disable-next-line no-bitwise
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/**
 * The address the TV should fetch from. Prefer the interface on the TV's own
 * subnet: the first non-internal IPv4 can just as well be a VPN tunnel or a
 * virtualization bridge (Parallels, Internet Sharing) the TV cannot reach, in
 * which case the cast loads forever.
 */
export function lanIpFor(
  targetAddress?: string,
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string | undefined {
  const candidates: os.NetworkInterfaceInfo[] = [];
  Object.keys(interfaces).forEach((name) => {
    (interfaces[name] || []).forEach((address) => {
      // The TV has to reach us, so loopback and IPv6 are no use here.
      if (address.family === 'IPv4' && !address.internal) candidates.push(address);
    });
  });
  const target = targetAddress ? ipv4ToInt(targetAddress) : undefined;
  if (target !== undefined) {
    const sameSubnet = candidates.find((address) => {
      const ip = ipv4ToInt(address.address);
      const mask = ipv4ToInt(address.netmask);
      if (ip === undefined || mask === undefined) return false;
      // eslint-disable-next-line no-bitwise
      return ((ip & mask) >>> 0) === ((target & mask) >>> 0);
    });
    if (sameSubnet) return sameSubnet.address;
  }
  return candidates.length ? candidates[0].address : undefined;
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
  ended: boolean;
  source: string;
  requestId: number;
  failed?: boolean;
}

export class CastService extends EventEmitter {
  private server?: http.Server;

  private device?: CastDevice;

  private deviceTarget = '';

  private deviceReady = false;

  private source = '';

  private requestId = 0;

  private filePath = '';

  /** Size of `filePath`, taken once per cast rather than per range request. */
  private fileSize = 0;

  private vtt = '';

  private port = 0;

  private knownDevices: CastDeviceInfo[] = [];

  private refreshing?: Promise<CastDeviceInfo[]>;

  private listing?: Promise<CastDeviceInfo[]>;

  private statusTimer?: NodeJS.Timeout;

  private statusBusy = false;

  private castCleanupDir?: string;

  /** A replacement or user stop invalidates older asynchronous preparation. */
  private castGeneration = 0;

  private mediaGeneration = 0;

  private castAbort?: AbortController;

  private lastStatus: CastStatus = {
    casting: false, currentTime: 0, duration: 0, paused: true,
    ended: false, source: '', requestId: 0,
  };

  /** One scan at a time; callers share the in-flight one. */
  private refresh(timeout?: number): Promise<CastDeviceInfo[]> {
    if (this.refreshing) return this.listing || this.refreshing;
    const cachePath = join(app.getPath('userData'), 'cast-devices.json');
    let showRemembered: (devices: CastDeviceInfo[]) => void;
    const rememberedReady = new Promise<CastDeviceInfo[]>((resolve) => {
      showRemembered = resolve;
    });
    this.refreshing = (async () => {
      let remembered = this.knownDevices;
      if (!remembered.length) {
        try {
          const cached = JSON.parse(await fs.promises.readFile(cachePath, 'utf8'));
          if (Array.isArray(cached)) {
            remembered = cached.filter(device => device
              && typeof device.id === 'string' && typeof device.name === 'string'
              && typeof device.host === 'string' && device.host
              && (device.ip === undefined || typeof device.ip === 'string')
              && Number.isInteger(device.port) && device.port > 0 && device.port <= 65535)
              .slice(0, 64);
          }
        } catch (error) { /* no readable cache yet */ }
      }
      return discoverWithKnown(remembered, timeout, (devices) => {
        if (devices.length) {
          this.knownDevices = devices;
          showRemembered(devices);
        }
      });
    })()
      .then(async (devices) => {
        this.knownDevices = devices;
        if (devices.length) {
          try {
            await fs.promises.writeFile(cachePath, JSON.stringify(devices));
          } catch (error) { /* discovery also works with a read-only profile */ }
        }
        this.refreshing = undefined;
        this.listing = undefined;
        return devices;
      })
      .catch(() => {
        this.refreshing = undefined;
        this.listing = undefined;
        return this.knownDevices;
      });
    this.listing = Promise.race([rememberedReady, this.refreshing]);
    return this.listing;
  }

  /**
   * Offer reachable saved TVs as soon as they answer, including after a restart.
   *
   * A scan has to sit out the whole mDNS window -- seconds -- so blocking on one
   * per click means the picker takes seconds to appear every single time. Answer
   * from what we already know and finish the scan behind the scenes. Discovery begins
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
    const url = (req.url || '').split('?')[0];
    if (url === `/subtitle-${this.mediaGeneration}.vtt` && this.filePath && this.vtt) {
      res.writeHead(200, {
        'Content-Type': 'text/vtt; charset=utf-8',
        'Access-Control-Allow-Origin': '*', // the receiver fetches this cross-origin
        'Content-Length': Buffer.byteLength(this.vtt),
      });
      res.end(this.vtt);
      return;
    }
    if (url !== `/video-${this.mediaGeneration}${extname(this.filePath)}`
      || !this.filePath || !this.fileSize) {
      res.writeHead(404);
      res.end();
      return;
    }
    const size = this.fileSize;
    const type = contentTypeOf(this.filePath) || 'video/mp4';
    // Without range support the device cannot seek, and some receivers refuse
    // to start at all. Suffix ranges ("bytes=-N", used to find a trailing moov)
    // and ends past EOF must be honoured exactly, or Content-Length promises
    // bytes that never arrive and the TV stalls.
    const range = parseByteRange(req.headers.range, size);
    if (range === null) {
      res.writeHead(416, {
        'Content-Range': `bytes */${size}`,
        'Access-Control-Allow-Origin': '*',
      });
      res.end();
      return;
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    const headers: http.OutgoingHttpHeaders = {
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': type,
      'Access-Control-Allow-Origin': '*',
    };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    // pipeline() closes the file when the TV aborts a request (it does so
    // constantly while seeking and buffering) and turns a read error — e.g. the
    // network share dropping — into a destroyed response instead of an
    // unhandled 'error' event in the main process.
    pipeline(fs.createReadStream(this.filePath, { start, end }), res, () => {});
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
    requestId = 0,
  ): Promise<void> {
    const generation = this.supersedeCast();
    const abort = new AbortController();
    this.castAbort = abort;
    this.source = filePath;
    this.requestId = requestId;
    this.lastStatus = {
      source: filePath, requestId, casting: false, currentTime,
      duration: 0, paused: true, ended: false,
    };
    const superseded = () => generation !== this.castGeneration;
    const targetKey = `${target.ip || target.host}:${target.port}`;
    const existing = this.deviceReady && this.deviceTarget === targetKey ? this.device : undefined;
    this.stopStatusPolling();
    if (!existing) this.stopDevice();
    this.deviceReady = false;
    let source: CastSource | undefined;
    let device: CastDevice | undefined;
    try {
      if (existing) existing.pause();
      const ip = lanIpFor(target.ip || target.host);
      if (!ip) throw new Error('no-lan-address');
      source = await prepareCastSource(filePath, abort.signal);
      if (superseded()) throw new Error(CAST_SUPERSEDED);
      const { size } = await fs.promises.stat(source.filePath);
      if (superseded()) throw new Error(CAST_SUPERSEDED);
      const port = await this.serve();
      if (superseded()) throw new Error(CAST_SUPERSEDED);
      if (existing && this.device !== existing) throw new Error('cast connection closed');
      // Keep the paused receiver's old URL valid until its replacement is prepared.
      this.releaseCastSource();
      this.mediaGeneration = generation;
      this.castCleanupDir = source.cleanupDir;
      this.fileSize = size;
      this.filePath = source.filePath;
      this.vtt = cues.length ? cuesToVtt(cues) : '';
      const base = `http://${ip}:${port}`;

      device = existing || new CastDevice(target.ip || target.host, target.port);
      this.device = device;
      this.deviceTarget = targetKey;
      if (!existing) {
        const connectedDevice = device;
        connectedDevice.on('error', () => {});
        connectedDevice.on('media-status', (status: CastPlaybackStatus) => {
          this.updatePlaybackStatus(connectedDevice, this.mediaGeneration, status);
        });
        connectedDevice.on('close', () => {
          if (this.device !== connectedDevice) return;
          if (this.castAbort) this.castAbort.abort();
          this.device = undefined;
          this.deviceReady = false;
          this.releaseCastSource();
          this.stopStatusPolling();
          this.publishStatus({
            casting: false, currentTime: this.lastStatus.currentTime,
            duration: this.lastStatus.duration, paused: true,
          });
        });
        await device.connect();
        if (superseded()) throw new Error(CAST_SUPERSEDED);
        if (this.device !== device) throw new Error('cast connection closed');
      }
      const image = source.contentType.indexOf('image/') === 0;
      const media: CastMedia = {
        url: `${base}/video-${generation}${source.extension}`,
        contentType: source.contentType,
        title: basename(filePath),
        currentTime: image ? 0 : currentTime,
      };
      if (this.vtt && !image) {
        media.subtitleUrl = `${base}/subtitle-${generation}.vtt`;
        media.subtitleLanguage = 'zh-CN';
      }
      await device.load(media);
      if (superseded()) throw new Error(CAST_SUPERSEDED);
      if (this.device !== device) throw new Error('cast connection closed');
      device.setVolume(Math.max(0, Math.min(1, volume)));
      this.deviceReady = true;
      this.castAbort = undefined;
      this.publishStatus({
        casting: true, currentTime: media.currentTime || 0, duration: 0, paused: false,
      });
      if (!superseded()) this.startStatusPolling();
    } catch (error) {
      if (source && source.cleanupDir) removeCastDirectory(source.cleanupDir);
      if (superseded()) {
        // A replacement owns the state now; never stop its receiver or publish its failure.
        if (device && this.device !== device) device.stop();
        throw new Error(CAST_SUPERSEDED);
      }
      this.castAbort = undefined;
      this.stopDevice();
      this.releaseCastSource();
      this.publishStatus({
        casting: false, currentTime, duration: 0, paused: true,
        ...(this.lastStatus.failed ? { failed: true } : {}),
      });
      throw error;
    }
  }

  private publishStatus(
    status: Omit<CastStatus, 'source' | 'requestId' | 'ended'> & { ended?: boolean },
  ): void {
    this.lastStatus = Object.assign({ ended: false }, status, {
      source: this.source, requestId: this.requestId,
    });
    this.emit('status', this.lastStatus);
  }

  private startStatusPolling(): void {
    this.stopStatusPolling();
    const poll = async () => {
      if (!this.device || this.statusBusy) return;
      const device = this.device;
      const generation = this.castGeneration;
      this.statusBusy = true;
      try {
        const status = await device.getStatus();
        this.updatePlaybackStatus(device, generation, status);
      } catch (error) {
        // A transient status timeout must not tear down an otherwise live cast.
      } finally {
        if (generation === this.castGeneration) this.statusBusy = false;
      }
    };
    poll();
    this.statusTimer = setInterval(poll, 1000);
  }

  private updatePlaybackStatus(
    device: CastDevice, generation: number, status?: CastPlaybackStatus,
  ): void {
    if (this.device !== device || generation !== this.castGeneration
      || this.mediaGeneration !== generation || !status) return;
    if (status.failed) this.stop(true);
    else this.publishStatus(Object.assign({ casting: true }, status));
  }

  private stopStatusPolling(): void {
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = undefined;
    }
    this.statusBusy = false;
  }

  public play(): void {
    if (!this.device || !this.deviceReady) return;
    this.device.play();
    this.publishStatus(Object.assign({}, this.lastStatus, { casting: true, paused: false, ended: false }));
  }

  public pause(): void {
    if (!this.device || !this.deviceReady) return;
    this.device.pause();
    this.publishStatus(Object.assign({}, this.lastStatus, { casting: true, paused: true, ended: false }));
  }

  public seek(seconds: number): void {
    if (!this.device || !this.deviceReady) return;
    this.device.seek(seconds);
    this.publishStatus(Object.assign({}, this.lastStatus, { casting: true, currentTime: seconds, ended: false }));
  }

  public setVolume(level: number): void {
    if (this.device) this.device.setVolume(Math.max(0, Math.min(1, level)));
  }

  private stopDevice(): void {
    this.deviceReady = false;
    this.deviceTarget = '';
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
    // Stop serving the old file; its transcoded copy is about to be deleted.
    this.filePath = '';
    this.fileSize = 0;
    this.vtt = '';
    this.mediaGeneration = 0;
    if (directory) removeCastDirectory(directory);
  }

  /** Invalidate any cast() still preparing and kill its probe/transcode. */
  private supersedeCast(): number {
    this.castGeneration += 1;
    if (this.castAbort) {
      this.castAbort.abort();
      this.castAbort = undefined;
    }
    return this.castGeneration;
  }

  /** Stop casting and release the port. */
  public stop(failed = false): void {
    if (failed) {
      if (this.castAbort) this.castAbort.abort();
      this.castAbort = undefined;
    } else this.supersedeCast();
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
      ...(failed ? { failed: true } : {}),
    });
  }

  public get casting(): boolean { return !!this.device; }
}

export const castService = new CastService();
