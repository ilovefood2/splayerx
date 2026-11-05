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

type PendingRequest = {
  resolve: (payload?: object, error?: Error) => void,
  mediaUrl?: string,
};

interface ReceiverMediaStatus {
  mediaSessionId?: number;
  currentTime?: number;
  playerState?: string;
  idleReason?: string;
  media?: { duration?: number, contentId?: string };
}

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
  ended: boolean;
  failed: boolean;
}

export class CastDevice extends EventEmitter {
  private socket?: tls.TLSSocket;

  private buffer = Buffer.alloc(0);

  private requestId = 1;

  private heartbeat?: NodeJS.Timeout;

  private sessionId?: string;

  private transportId?: string;

  private mediaSessionId?: number;

  private mediaUrl?: string;

  private loading = false;

  // Bind each pending reply to the media URL that sent the request.
  private readonly pending = new Map<number, PendingRequest>();

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
      this.pending.set(id, {
        mediaUrl: namespace === NS_MEDIA ? this.mediaUrl : undefined,
        resolve: (reply, error) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve(reply as object);
        },
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
        this.rejectPending();
        this.emit('close');
        // stop() before the handshake finished; no-op once connected.
        reject(new Error('cast connection closed'));
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
    let payload: {
      requestId?: number,
      type?: string,
      status?: ReceiverMediaStatus[],
    };
    try {
      payload = JSON.parse(frame.payload);
    } catch (e) {
      return;
    }
    if (frame.namespace === NS_HEARTBEAT && payload.type === 'PING') {
      this.send(NS_HEARTBEAT, { type: 'PONG' });
      return;
    }
    let requested = false;
    if (payload.requestId !== undefined) {
      const pending = this.pending.get(payload.requestId);
      if (pending) {
        requested = true;
        this.pending.delete(payload.requestId);
        pending.resolve(payload);
        if (frame.namespace === NS_MEDIA && pending.mediaUrl !== this.mediaUrl) return;
      }
    }
    if (frame.namespace === NS_MEDIA) {
      // A few receivers start playback successfully but omit the media session
      // from the direct LOAD reply. They announce it in the following
      // MEDIA_STATUS frame instead. Without capturing that frame, transport
      // controls are silently ignored because mediaCommand has no session ID.
      const status = this.playbackStatus(payload.status && payload.status[0], requested);
      if (status && (!requested || status.ended || status.failed)) this.emit('media-status', status);
    }
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
    const image = media.contentType.indexOf('image/') === 0;
    this.mediaUrl = media.url;
    this.mediaSessionId = undefined;
    this.loading = true;
    const tracks = media.subtitleUrl && !image ? [{
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
      currentTime: image ? 0 : media.currentTime || 0,
      media: {
        contentId: media.url,
        streamType: image ? 'NONE' : 'BUFFERED',
        contentType: media.contentType,
        metadata: { type: image ? 4 : 0, metadataType: image ? 4 : 0, title: media.title || '' },
        tracks,
        textTrackStyle: tracks ? {
          backgroundColor: '#00000000',
          foregroundColor: '#FFFFFFFF',
          edgeType: 'OUTLINE',
          edgeColor: '#000000FF',
        } : undefined,
      },
      activeTrackIds: tracks ? [1] : undefined,
    }, this.transportId).finally(() => { this.loading = false; }) as {
      type?: string, status?: ReceiverMediaStatus[],
    };

    const loaded = reply.status && reply.status[0];
    if ((reply.type && reply.type !== 'MEDIA_STATUS')
      || (loaded && loaded.playerState === 'IDLE' && loaded.idleReason === 'ERROR')) {
      // Usually the codec: the Default Media Receiver plays H.264/VP8 + AAC/MP3.
      throw new Error('the device refused the media (unsupported codec?)');
    }
    if (reply.status && reply.status.length) this.mediaSessionId = reply.status[0].mediaSessionId;

    // GET_STATUS is valid without a mediaSessionId and covers receivers whose
    // asynchronous MEDIA_STATUS has not arrived by the time LOAD resolves.
    if (this.mediaSessionId === undefined) await this.getStatus();
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
    if (!this.transportId) return undefined;
    const mediaUrl = this.mediaUrl;
    const request: { type: string, mediaSessionId?: number } = { type: 'GET_STATUS' };
    if (this.mediaSessionId !== undefined) request.mediaSessionId = this.mediaSessionId;
    const reply = await this.request(NS_MEDIA, request, this.transportId) as { status?: ReceiverMediaStatus[] };
    if (mediaUrl !== this.mediaUrl) return undefined;
    return this.playbackStatus(reply.status && reply.status[0], true);
  }

  private playbackStatus(
    status?: ReceiverMediaStatus, requested = false,
  ): CastPlaybackStatus | undefined {
    if (!status) return undefined;
    const contentId = status.media && status.media.contentId;
    if (contentId && contentId !== this.mediaUrl) return undefined;
    if (!contentId && ((this.loading && this.mediaSessionId === undefined && !requested)
      || (this.mediaSessionId !== undefined
      && status.mediaSessionId !== this.mediaSessionId))) return undefined;
    if (status.mediaSessionId !== undefined) this.mediaSessionId = status.mediaSessionId;
    return {
      currentTime: status.currentTime || 0,
      duration: status.media && status.media.duration ? status.media.duration : 0,
      paused: status.playerState !== 'PLAYING' && status.playerState !== 'BUFFERING',
      ended: status.playerState === 'IDLE' && status.idleReason === 'FINISHED',
      failed: status.playerState === 'IDLE' && status.idleReason === 'ERROR',
    };
  }

  public setVolume(level: number): void {
    // SET_VOLUME does not necessarily clear a mute state left by the previous
    // receiver session. Keep the TV's mute bit in sync with SPlayer's level.
    this.send(NS_RECEIVER, {
      type: 'SET_VOLUME',
      volume: { level, muted: level <= 0 },
      requestId: this.requestId += 1,
    });
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  private rejectPending(): void {
    const error = new Error('cast connection closed');
    this.pending.forEach(request => request.resolve(undefined, error));
    this.pending.clear();
  }

  /** Stop playback and close. Leaves the receiver app shut down, not idling. */
  public stop(): void {
    try {
      if (this.sessionId) {
        this.send(NS_RECEIVER, { type: 'STOP', sessionId: this.sessionId, requestId: this.requestId += 1 });
      }
    } catch (e) { /* socket may already be gone */ }
    this.stopHeartbeat();
    this.rejectPending();
    if (this.socket) {
      try { this.socket.end(); } catch (e) { /* already closed */ }
      this.socket = undefined;
    }
    this.transportId = undefined;
    this.sessionId = undefined;
    this.mediaSessionId = undefined;
    this.mediaUrl = undefined;
  }
}
