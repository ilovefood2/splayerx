/**
 * A castv2 session with one Chromecast.
 *
 * Connect over TLS to :8009, keep the heartbeat alive, launch the Default Media
 * Receiver, and drive playback. The device closes the socket if it stops hearing
 * PINGs, so the heartbeat is not optional.
 *
 * NOTE: no `?.`/`??` — webpack 4 cannot parse them.
 */

import tls from 'tls';
import { EventEmitter } from 'events';
import { encodeFrame, readFrames, CastFrame } from './castMessage';

const NS_CONNECTION = 'urn:x-cast:com.google.cast.tp.connection';
const NS_HEARTBEAT = 'urn:x-cast:com.google.cast.tp.heartbeat';
const NS_RECEIVER = 'urn:x-cast:com.google.cast.receiver';
const NS_MEDIA = 'urn:x-cast:com.google.cast.media';

/** Google's Default Media Receiver: plays a URL, no custom app needed. */
const DEFAULT_RECEIVER_APP_ID = 'CC1AD845';
const HEARTBEAT_INTERVAL = 5000;
const CONNECT_TIMEOUT = 8000;

type PendingResolver = (payload: object) => void;

export interface CastMedia {
  /** URL the device will fetch. Must be reachable from the TV, not just here. */
  url: string;
  contentType: string;
  title?: string;
  /** Optional sidecar WebVTT track. */
  subtitleUrl?: string;
  subtitleLanguage?: string;
  /** Continue from the local player's current position. */
  currentTime?: number;
}

export interface CastPlaybackStatus {
  currentTime: number;
  duration: number;
  paused: boolean;
}

export class CastDevice extends EventEmitter {
  private socket?: tls.TLSSocket;

  private buffer = Buffer.alloc(0);

  private requestId = 1;

  private heartbeat?: NodeJS.Timeout;

  private sessionId?: string;

  private transportId?: string;

  private mediaSessionId?: number;

  // Aliased rather than inlined: eslint's no-spaced-func misparses a function
  // type written inside the generic argument list.
  private readonly pending = new Map<number, PendingResolver>();

  public constructor(private readonly host: string, private readonly port = 8009) {
    super();
  }

  private send(namespace: string, payload: object, destination = 'receiver-0'): void {
    if (!this.socket) return;
    this.socket.write(encodeFrame({
      source: 'sender-0',
      destination,
      namespace,
      payload: JSON.stringify(payload),
    }));
  }

  /** Send a request and wait for the reply with the matching requestId. */
  private request(namespace: string, payload: object, destination?: string): Promise<object> {
    this.requestId += 1;
    const id = this.requestId;
    const body = Object.assign({}, payload, { requestId: id });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`cast request ${JSON.stringify(payload)} timed out`));
      }, CONNECT_TIMEOUT);
      this.pending.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      this.send(namespace, body, destination);
    });
  }

  public connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      // The device presents a self-signed certificate; that is expected.
      const socket = tls.connect({
        host: this.host, port: this.port, rejectUnauthorized: false,
      }, () => {
        this.send(NS_CONNECTION, { type: 'CONNECT' });
        this.heartbeat = setInterval(() => this.send(NS_HEARTBEAT, { type: 'PING' }),
          HEARTBEAT_INTERVAL);
        resolve();
      });
      socket.setTimeout(0);
      socket.on('data', (data: Buffer) => this.onData(data));
      socket.on('error', (error: Error) => {
        this.emit('error', error);
        reject(error);
      });
      socket.on('close', () => {
        this.stopHeartbeat();
        this.emit('close');
      });
      this.socket = socket;
    });
  }

  private onData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    const { frames, rest } = readFrames(this.buffer);
    this.buffer = rest;
    frames.forEach(frame => this.onFrame(frame));
  }

  private onFrame(frame: CastFrame): void {
    let payload: { requestId?: number, type?: string, status?: object };
    try {
      payload = JSON.parse(frame.payload);
    } catch (e) {
      return;
    }
    if (frame.namespace === NS_HEARTBEAT && payload.type === 'PING') {
      this.send(NS_HEARTBEAT, { type: 'PONG' });
      return;
    }
    if (payload.requestId !== undefined) {
      const resolver = this.pending.get(payload.requestId);
      if (resolver) {
        this.pending.delete(payload.requestId);
        resolver(payload);
      }
    }
    if (frame.namespace === NS_MEDIA) this.emit('media-status', payload);
  }

  /** Start the Default Media Receiver and open a connection to it. */
  private async launch(): Promise<void> {
    const reply = await this.request(NS_RECEIVER, {
      type: 'LAUNCH', appId: DEFAULT_RECEIVER_APP_ID,
    }) as { status?: { applications?: { sessionId: string, transportId: string }[] } };
    const applications = reply.status && reply.status.applications;
    if (!applications || !applications.length) throw new Error('receiver did not launch');
    this.sessionId = applications[0].sessionId;
    this.transportId = applications[0].transportId;
    // The media channel needs its own CONNECT, addressed to the app.
    this.send(NS_CONNECTION, { type: 'CONNECT' }, this.transportId);
  }

  public async load(media: CastMedia): Promise<void> {
    if (!this.transportId) await this.launch();
    const tracks = media.subtitleUrl ? [{
      trackId: 1,
      type: 'TEXT',
      trackContentId: media.subtitleUrl,
      trackContentType: 'text/vtt',
      subtype: 'SUBTITLES',
      language: media.subtitleLanguage || 'zh-CN',
      name: 'AI',
    }] : undefined;

    const reply = await this.request(NS_MEDIA, {
      type: 'LOAD',
      autoplay: true,
      currentTime: media.currentTime || 0,
      media: {
        contentId: media.url,
        streamType: 'BUFFERED',
        contentType: media.contentType,
        metadata: { type: 0, metadataType: 0, title: media.title || '' },
        tracks,
        textTrackStyle: tracks ? {
          backgroundColor: '#00000000',
          foregroundColor: '#FFFFFFFF',
          edgeType: 'OUTLINE',
          edgeColor: '#000000FF',
        } : undefined,
      },
      activeTrackIds: tracks ? [1] : undefined,
    }, this.transportId) as { type?: string, status?: { mediaSessionId: number }[] };

    if (reply.type === 'LOAD_FAILED') {
      // Usually the codec: the Default Media Receiver plays H.264/VP8 + AAC/MP3.
      throw new Error('the device refused the media (unsupported codec?)');
    }
    if (reply.status && reply.status.length) this.mediaSessionId = reply.status[0].mediaSessionId;
  }

  private mediaCommand(type: string, extra: object = {}): void {
    if (!this.transportId || this.mediaSessionId === undefined) return;
    this.requestId += 1;
    this.send(NS_MEDIA, Object.assign({
      type, mediaSessionId: this.mediaSessionId, requestId: this.requestId,
    }, extra), this.transportId);
  }

  public play(): void { this.mediaCommand('PLAY'); }

  public pause(): void { this.mediaCommand('PAUSE'); }

  public seek(seconds: number): void { this.mediaCommand('SEEK', { currentTime: seconds }); }

  /** Ask the receiver for its authoritative playback position and state. */
  public async getStatus(): Promise<CastPlaybackStatus | undefined> {
    if (!this.transportId || this.mediaSessionId === undefined) return undefined;
    const reply = await this.request(NS_MEDIA, {
      type: 'GET_STATUS', mediaSessionId: this.mediaSessionId,
    }, this.transportId) as {
      status?: {
        currentTime?: number,
        playerState?: string,
        media?: { duration?: number },
      }[],
    };
    const status = reply.status && reply.status[0];
    if (!status) return undefined;
    return {
      currentTime: status.currentTime || 0,
      duration: status.media && status.media.duration ? status.media.duration : 0,
      paused: status.playerState !== 'PLAYING' && status.playerState !== 'BUFFERING',
    };
  }

  public setVolume(level: number): void {
    this.send(NS_RECEIVER, { type: 'SET_VOLUME', volume: { level }, requestId: this.requestId += 1 });
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  /** Stop playback and close. Leaves the receiver app shut down, not idling. */
  public stop(): void {
    try {
      if (this.sessionId) {
        this.send(NS_RECEIVER, { type: 'STOP', sessionId: this.sessionId, requestId: this.requestId += 1 });
      }
    } catch (e) { /* socket may already be gone */ }
    this.stopHeartbeat();
    if (this.socket) {
      try { this.socket.end(); } catch (e) { /* already closed */ }
      this.socket = undefined;
    }
    this.transportId = undefined;
    this.sessionId = undefined;
    this.mediaSessionId = undefined;
  }
}
