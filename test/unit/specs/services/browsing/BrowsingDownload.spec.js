import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';

const youtubeDl = vi.hoisted(() => ({ getInfo: vi.fn() }));
vi.mock('@splayer/youtube-dl', () => ({ default: youtubeDl }));

import BrowsingDownload from '@/services/browsing/BrowsingDownload';

const payload = Buffer.from('modern download transport');

function waitUntil(predicate, timeout = 3000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) {
        resolve();
      } else if (Date.now() - startedAt >= timeout) {
        reject(new Error('Timed out waiting for download'));
      } else {
        setTimeout(check, 10);
      }
    };
    check();
  });
}

describe('BrowsingDownload', () => {
  let server;
  let origin;
  let tempDirectory;
  let requests;
  let sendSpy;

  beforeEach(async () => {
    requests = [];
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'splayer-download-test-'));
    server = http.createServer((request, response) => {
      requests.push({ url: request.url, headers: request.headers });
      if (request.url === '/redirect') {
        response.writeHead(302, { Location: '/video' });
        response.end();
        return;
      }

      const start = Number.parseInt(request.headers.range?.replace('bytes=', '') || '0', 10);
      const body = payload.subarray(start);
      response.writeHead(start ? 206 : 200, { 'Content-Length': body.length });
      response.end(body);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    origin = `http://127.0.0.1:${address.port}`;
    sendSpy = vi.spyOn(electron.ipcRenderer, 'send');
  });

  afterEach(async () => {
    sendSpy.mockRestore();
    youtubeDl.getInfo.mockReset();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  });

  it('follows redirects and preserves request headers', async () => {
    youtubeDl.getInfo.mockImplementation((source, options, callback) => callback(null, {
      url: `${origin}/redirect`,
      size: payload.length,
      http_headers: {},
    }));
    const download = new BrowsingDownload('source', 'item', 'download');

    download.startDownload('format', 'video.bin', tempDirectory, { Cookie: 'session=test' });
    await waitUntil(() => sendSpy.mock.calls.some(([channel]) => channel === 'show-notification'));

    expect(fs.readFileSync(path.join(tempDirectory, 'video.bin'))).to.deep.equal(payload);
    expect(requests.map(request => request.url)).to.deep.equal(['/redirect', '/video']);
    expect(requests[1].headers.cookie).to.equal('session=test');
  });

  it('resumes from the existing byte without duplicating data', async () => {
    youtubeDl.getInfo.mockImplementation((source, options, callback) => callback(null, {
      url: `${origin}/video`,
      size: payload.length,
      http_headers: {},
    }));
    const existingLength = 7;
    fs.writeFileSync(path.join(tempDirectory, 'video.bin'), payload.subarray(0, existingLength));
    const download = new BrowsingDownload('source', 'item', 'download');

    download.continueDownload('format', 'video.bin', tempDirectory, existingLength);
    await waitUntil(() => sendSpy.mock.calls.some(([channel]) => channel === 'show-notification'));

    expect(requests[0].headers.range).to.equal(`bytes=${existingLength}-`);
    expect(download.getSize()).to.equal(payload.length);
    expect(fs.readFileSync(path.join(tempDirectory, 'video.bin'))).to.deep.equal(payload);
  });
});
