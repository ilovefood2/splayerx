/**
 * Cast the playing file to a Chromecast.
 *
 * The device fetches the video over HTTP from us, so this serves the file on the
 * LAN (with range support, or the TV cannot seek) alongside a WebVTT track for
 * the AI subtitles, then points the device at those URLs.
 *
 * Direct play only: the Default Media Receiver decodes H.264/VP8/VP9 with
 * AAC/MP3/Opus. Anything else is refused rather than silently failing on the TV.
 *
 * NOTE: no `?.`/`??` — webpack 4 cannot parse them.
 */

import http from 'http';
import fs from 'fs';
import os from 'os';
import { extname, basename } from 'path';
import { CastDevice, CastMedia } from './CastDevice';
import { discoverWithKnown, CastDeviceInfo } from './CastDiscovery';

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

export class CastService {
  private server?: http.Server;

  private device?: CastDevice;

  private filePath = '';

  private vtt = '';

  private port = 0;

  private knownDevices: CastDeviceInfo[] = [];

  /**
   * Devices to offer the user.
   *
   * Remembers what it has seen: a TV that has stopped answering mDNS is still
   * listed as long as it answers on :8009, which is how it stays castable after
   * going idle.
   */
  public async listDevices(timeout?: number): Promise<CastDeviceInfo[]> {
    const devices = await discoverWithKnown(this.knownDevices, timeout);
    this.knownDevices = devices;
    return devices;
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
  ): Promise<void> {
    const contentType = contentTypeOf(filePath);
    if (!contentType) {
      throw new Error(`unsupported-container:${extname(filePath).slice(1) || '?'}`);
    }
    const ip = firstLanIp();
    if (!ip) throw new Error('no-lan-address');

    this.filePath = filePath;
    this.vtt = cues.length ? cuesToVtt(cues) : '';
    const port = await this.serve();
    const base = `http://${ip}:${port}`;

    this.stopDevice();
    const device = new CastDevice(target.ip || target.host, target.port);
    this.device = device;
    await device.connect();
    const media: CastMedia = {
      url: `${base}/video${extname(filePath)}`,
      contentType,
      title: basename(filePath),
    };
    if (this.vtt) {
      media.subtitleUrl = `${base}/subtitle.vtt`;
      media.subtitleLanguage = 'zh-CN';
    }
    await device.load(media);
  }

  public play(): void { if (this.device) this.device.play(); }

  public pause(): void { if (this.device) this.device.pause(); }

  public seek(seconds: number): void { if (this.device) this.device.seek(seconds); }

  private stopDevice(): void {
    if (this.device) {
      this.device.stop();
      this.device = undefined;
    }
  }

  /** Stop casting and release the port. */
  public stop(): void {
    this.stopDevice();
    if (this.server) {
      try { this.server.close(); } catch (e) { /* not listening */ }
      this.server = undefined;
      this.port = 0;
    }
  }

  public get casting(): boolean { return !!this.device; }
}

export const castService = new CastService();
