import electron from 'electron';
// @ts-ignore
import youtubedl from '@splayer/youtube-dl';
import fs from 'fs';
import Path from 'path';
import http from 'http';
import https from 'https';
import { PassThrough } from 'stream';
import { log } from '@/libs/Log';
import { IBrowsingDownload } from '@/interfaces/IBrowsingDownload';

interface DownloadItem {
  url: string;
  size?: number;
  http_headers?: Record<string, string>;
}

class BrowsingDownload implements IBrowsingDownload {
  private url: string;

  private id: string;

  private downloadId: string;

  private progress: number;

  private initProgress: number;

  private size: number;

  private path: string;

  private name: string;

  private req: http.ClientRequest | null;

  private response: http.IncomingMessage | null;

  private progressTimer: NodeJS.Timeout | null;

  private paused: boolean;

  private lastProgress: number;

  private manualAbort: boolean;

  public constructor(url: string, id?: string, downloadId?: string) {
    this.url = url;
    this.paused = false;
    this.manualAbort = false;
    this.req = null;
    this.response = null;
    this.progressTimer = null;
    this.id = id || '';
    this.downloadId = downloadId || '';
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async getDownloadVideo(Cookie: string): Promise<any> {
    const options = Cookie ? ['--add-header', `Cookie:"${Cookie}"`] : [];
    return new Promise(((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      youtubedl.getInfo(this.url, options, (err: any, info: any) => {
        if (err) {
          reject(err);
          return;
        }
        resolve({ info, url: this.url });
      });
    }));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public startDownload(id: string, name: string, path: string, headers: any): void {
    this.progress = 0;
    this.initProgress = 0;
    this.lastProgress = 0;
    this.manualAbort = false;
    const options = headers.Cookie ? ['--add-header', `Cookie:"${headers.Cookie}"`] : [];
    const stream = new PassThrough();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    youtubedl.getInfo(this.url, options.concat(['-f', id]), (err: any, data: any) => (err || this.manualAbort ? stream.emit('error', err || 'manual abort') : this.processData(data, stream, headers)));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stream.on('info', (info: any) => {
      this.size = info.size + this.initProgress;
      electron.ipcRenderer.send('transfer-download-info', {
        id: this.id, downloadId: this.downloadId, url: this.url, name, path, size: this.size,
      });
      this.path = path;
      this.name = name;
      stream.pipe(fs.createWriteStream(Path.join(path, name)));
    });
    stream.on('data', (chunk: Buffer) => {
      if (!fs.existsSync(Path.join(this.path, this.name))) {
        log.error('file not found', Path.join(this.path, this.name));
        this.abort();
        this.req = null;
        electron.ipcRenderer.emit(
          'file-not-found', {} as Electron.IpcRendererEvent, this.id,
        );
      }
      this.progress += chunk.length;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stream.on('error', (e: any) => {
      electron.ipcRenderer.send('start-download-error');
      log.error('download video error', e.message || e);
      this.clearActiveRequest();
    });
    stream.on('end', () => {
      if (this.progress >= this.size) {
        electron.ipcRenderer.send('transfer-progress', { id: this.id, pos: this.size, speed: 0 });
        electron.ipcRenderer.send('show-notification', { name: this.name, path: this.path });
        log.info('download complete', path);
      }
      this.clearActiveRequest();
    });
  }

  public pause() {
    if (this.req) {
      this.response?.pause();
      this.paused = true;
    }
  }

  public resume() {
    if (this.req) {
      this.response?.resume();
      this.paused = false;
    }
  }

  public abort() {
    if (this.req) {
      this.req.destroy();
      this.response?.destroy();
    }
  }

  public getId() {
    return this.id;
  }

  public getDownloadId() {
    return this.downloadId;
  }

  public getProgress(): number {
    return this.progress;
  }

  public getSize(): number {
    return this.size;
  }

  public getUrl(): string {
    return this.url;
  }

  public getName(): string {
    return this.name;
  }

  public getPath(): string {
    return this.path;
  }

  public killProcess(): void {
    this.manualAbort = true;
    this.abort();
  }

  public continueDownload(id: string, name: string, path: string, lastIndex: number): void {
    this.initProgress = lastIndex;
    this.progress = lastIndex;
    this.lastProgress = lastIndex;
    this.manualAbort = false;
    const stream = new PassThrough();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    youtubedl.getInfo(this.url, ['-f', id], (err: any, data: any) => (err ? stream.emit('error', err) : this.processData(data, stream, {}, { start: lastIndex })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stream.on('info', (info: any) => {
      this.size = info.size + this.initProgress;
      this.path = path;
      this.name = name;
      stream.pipe(fs.createWriteStream(Path.join(path, name), { flags: 'a' }));
    });
    stream.on('data', (chunk: Buffer) => {
      if (!fs.existsSync(Path.join(this.path, this.name))) {
        log.error('file not found', Path.join(this.path, this.name));
        this.abort();
        this.req = null;
        electron.ipcRenderer.emit(
          'file-not-found', {} as Electron.IpcRendererEvent, this.id,
        );
      }
      this.progress += chunk.length;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stream.on('error', (e: any) => {
      electron.ipcRenderer.send('downloading-network-error', this.id);
      log.error('download video error', e.message);
      this.clearActiveRequest();
    });
    stream.on('end', () => {
      if (this.progress >= this.size) {
        electron.ipcRenderer.send('transfer-progress', { id: this.id, pos: this.size, speed: 0 });
        electron.ipcRenderer.send('show-notification', { name: this.name, path: this.path });
        log.info('download complete', path);
      }
      this.clearActiveRequest();
    });
  }

  private processData(
    data: DownloadItem | DownloadItem[],
    stream: PassThrough,
    reqHeaders: Record<string, string>,
    options?: { start: number },
  ) {
    const items = Array.isArray(data) ? [...data] : [data];
    const firstItem = items[0];
    if (!firstItem?.url) {
      stream.destroy(new Error('No downloadable media URL was returned'));
      return;
    }

    this.startProgressUpdates();
    this.downloadItems(items, stream, reqHeaders, options?.start || 0)
      .then(() => stream.end())
      .catch((error) => {
        if (!this.manualAbort) {
          electron.ipcRenderer.send('downloading-network-error', this.id);
          stream.destroy(error);
        }
      })
      .finally(() => this.clearActiveRequest());
  }

  private async downloadItems(
    items: DownloadItem[],
    stream: PassThrough,
    reqHeaders: Record<string, string>,
    start: number,
  ) {
    let infoSent = false;
    for (const item of items) {
      if (this.manualAbort) throw new Error('Download aborted');
      await this.downloadItem(
        item,
        stream,
        reqHeaders,
        infoSent ? 0 : start,
        (size) => {
          if (infoSent) return;
          item.size = start > 0 || !Number.isFinite(item.size) ? size : item.size;
          stream.emit('info', item);
          infoSent = true;
        },
      );
    }
  }

  private downloadItem(
    item: DownloadItem,
    stream: PassThrough,
    reqHeaders: Record<string, string>,
    start: number,
    onReady: (size: number) => void,
    redirectCount = 0,
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      if (redirectCount > 5) {
        reject(new Error('Too many download redirects'));
        return;
      }

      const target = new URL(item.url);
      const headers = { ...reqHeaders, ...(item.http_headers || {}) };
      if (start > 0) headers.Range = `bytes=${start}-`;
      const transport = target.protocol === 'https:' ? https : http;
      const request = transport.get(target, { headers }, (response) => {
        this.response = response;
        const statusCode = response.statusCode || 0;
        if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
          response.resume();
          item.url = new URL(response.headers.location, target).toString();
          this.downloadItem(item, stream, reqHeaders, start, onReady, redirectCount + 1)
            .then(resolve, reject);
          return;
        }

        const contentLength = Number.parseInt(response.headers['content-length'] || '0', 10);
        if (start > 0 && statusCode === 416) {
          onReady(0);
          response.resume();
          resolve(0);
          return;
        }
        if (statusCode !== 200 && statusCode !== 206) {
          response.resume();
          reject(new Error(`status code ${statusCode}`));
          return;
        }

        onReady(contentLength);
        const resumeAfterDrain = () => {
          if (!this.paused) response.resume();
        };
        const removeDrainListener = () => stream.off('drain', resumeAfterDrain);
        response.on('data', (chunk) => {
          if (!stream.write(chunk)) response.pause();
        });
        stream.on('drain', resumeAfterDrain);
        response.once('end', () => {
          removeDrainListener();
          resolve(contentLength);
        });
        response.once('error', (error) => {
          removeDrainListener();
          reject(error);
        });
        response.once('aborted', () => {
          removeDrainListener();
          reject(new Error('Download response was aborted'));
        });
      });
      this.req = request;
      request.once('error', reject);
    });
  }

  private startProgressUpdates() {
    if (this.progressTimer) clearInterval(this.progressTimer);
    this.progressTimer = setInterval(() => {
      if (this.paused) return;
      const speed = this.progress - this.lastProgress;
      this.lastProgress = this.progress;
      electron.ipcRenderer.send('transfer-progress', { id: this.id, pos: this.progress, speed });
    }, 1000);
  }

  private clearActiveRequest() {
    if (this.progressTimer) clearInterval(this.progressTimer);
    this.progressTimer = null;
    this.req = null;
    this.response = null;
  }
}

export default BrowsingDownload;
