import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const discoverWithKnown = vi.hoisted(() => vi.fn());

vi.mock('../../../../src/main/helpers/cast/CastDiscovery', () => ({
  discoverWithKnown,
}));

vi.mock('../../../../src/main/helpers/ffmpeg', () => ({
  runMediaBinary: vi.fn(),
}));

import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { runMediaBinary } from '../../../../src/main/helpers/ffmpeg';
import {
  CAST_SUPERSEDED, CastService, canDirectCast, lanIpFor,
} from '../../../../src/main/helpers/cast/CastService';

describe('CastService discovery lifecycle', () => {
  beforeEach(() => {
    discoverWithKnown.mockReset();
  });

  it('does not start discovery until the user opens the cast picker', async () => {
    const service = new CastService();
    const devices = [{
      id: 'living-room._googlecast._tcp.local',
      name: 'Living Room',
      host: 'living-room.local',
      port: 8009,
    }];
    discoverWithKnown.mockResolvedValue(devices);

    expect(discoverWithKnown).not.toHaveBeenCalled();
    await expect(service.listDevices(250)).resolves.toEqual(devices);
    expect(discoverWithKnown).toHaveBeenCalledOnce();
    expect(discoverWithKnown).toHaveBeenCalledWith([], 250);
  });

  it('returns cached devices immediately and refreshes only after a picker request', async () => {
    const service = new CastService();
    const initial = [{
      id: 'bedroom._googlecast._tcp.local',
      name: 'Bedroom',
      host: 'bedroom.local',
      port: 8009,
    }];
    discoverWithKnown.mockResolvedValueOnce(initial).mockResolvedValueOnce(initial);

    await service.listDevices();
    await expect(service.listDevices()).resolves.toEqual(initial);

    expect(discoverWithKnown).toHaveBeenCalledTimes(2);
    expect(discoverWithKnown).toHaveBeenLastCalledWith(initial, undefined);
  });
});

describe('Chromecast media compatibility', () => {
  const h264 = { codec_type: 'video', codec_name: 'h264' };

  it('keeps supported MP4 audio on the direct path', () => {
    expect(canDirectCast('/media/movie.mp4', {
      streams: [h264, { codec_type: 'audio', codec_name: 'aac' }],
    })).to.equal(true);
  });

  it('does not direct-cast containers or audio codecs the receiver may drop', () => {
    expect(canDirectCast('/media/movie.mkv', {
      streams: [h264, { codec_type: 'audio', codec_name: 'aac' }],
    })).to.equal(false);
    expect(canDirectCast('/media/movie.mp4', {
      streams: [h264, { codec_type: 'audio', codec_name: 'dts' }],
    })).to.equal(false);
  });

  it('allows a supported WebM video/audio pair', () => {
    expect(canDirectCast('/media/movie.webm', {
      streams: [
        { codec_type: 'video', codec_name: 'vp9' },
        { codec_type: 'audio', codec_name: 'opus' },
      ],
    })).to.equal(true);
  });
});

function get(port, headers = {}) {
  return new Promise((resolve) => {
    http.get(`http://127.0.0.1:${port}/video.mp4`, { headers }, (response) => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
      // A read failure destroys the response; that is an answer, not a crash.
      response.on('error', () => resolve({ statusCode: response.statusCode, aborted: true }));
    }).on('error', () => resolve({ aborted: true }));
  });
}

describe('Chromecast file server', () => {
  const content = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
  let filePath;
  let service;
  let port;

  beforeEach(async () => {
    filePath = path.join(os.tmpdir(), `splayer-cast-${Date.now()}-${Math.random()}.mp4`);
    fs.writeFileSync(filePath, content);
    service = new CastService();
    // What cast() sets up once the source is prepared.
    service.filePath = filePath;
    service.fileSize = content.length;
    port = await service.serve();
  });

  afterEach(() => {
    service.stop();
    fs.rmSync(filePath, { force: true });
  });

  it('serves the whole file without a range', async () => {
    const response = await get(port);
    expect(response.statusCode).to.equal(200);
    expect(response.body.equals(content)).to.equal(true);
  });

  it('serves a suffix range from the end of the file, not the start', async () => {
    const response = await get(port, { Range: 'bytes=-10' });
    expect(response.statusCode).to.equal(206);
    expect(response.headers['content-range']).to.equal('bytes 90-99/100');
    expect(response.body.equals(content.subarray(90))).to.equal(true);
  });

  it('clamps a range end past EOF so Content-Length matches the body', async () => {
    const response = await get(port, { Range: 'bytes=95-100000' });
    expect(response.statusCode).to.equal(206);
    expect(response.headers['content-length']).to.equal('5');
    expect(response.body.length).to.equal(5);
  });

  it('rejects a range that starts past EOF', async () => {
    const response = await get(port, { Range: 'bytes=200-' });
    expect(response.statusCode).to.equal(416);
    expect(response.headers['content-range']).to.equal('bytes */100');
  });

  it('survives the source becoming unreadable mid-cast', async () => {
    fs.rmSync(filePath, { force: true });
    const response = await get(port);
    // Before: an unhandled read-stream 'error' in the main process.
    expect(response.aborted || response.statusCode === 200).to.equal(true);
    // The server still answers afterwards.
    fs.writeFileSync(filePath, content);
    expect((await get(port, { Range: 'bytes=0-3' })).statusCode).to.equal(206);
  });
});

describe('Chromecast LAN address', () => {
  const vpn = { family: 'IPv4', internal: false, address: '10.8.0.2', netmask: '255.255.255.0' };
  const bridge = { family: 'IPv4', internal: false, address: '10.211.55.2', netmask: '255.255.255.0' };
  const wifi = { family: 'IPv4', internal: false, address: '192.168.1.20', netmask: '255.255.255.0' };
  const loopback = { family: 'IPv4', internal: true, address: '127.0.0.1', netmask: '255.0.0.0' };

  it("prefers the interface on the TV's subnet over an earlier VPN or VM bridge", () => {
    const interfaces = { lo0: [loopback], utun4: [vpn], bridge100: [bridge], en0: [wifi] };
    expect(lanIpFor('192.168.1.50', interfaces)).to.equal('192.168.1.20');
  });

  it('falls back to the first LAN address when the TV address is unknown', () => {
    const interfaces = { lo0: [loopback], en0: [wifi], bridge100: [bridge] };
    expect(lanIpFor('LivingRoom.local', interfaces)).to.equal('192.168.1.20');
    expect(lanIpFor(undefined, { lo0: [loopback] })).to.equal(undefined);
  });
});

describe('Chromecast cast superseded while preparing', () => {
  const target = {
    id: 'tv', name: 'TV', host: '192.168.1.20', ip: '192.168.1.20', port: 8009,
  };
  let transcodes;

  beforeEach(() => {
    transcodes = [];
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({
      en0: [{
        address: '192.168.1.5',
        netmask: '255.255.255.0',
        family: 'IPv4',
        internal: false,
        mac: '00:00:00:00:00:00',
        cidr: '192.168.1.5/24',
      }],
    });
    // HEVC needs a transcode; hold each one open until the test finishes it.
    runMediaBinary.mockImplementation((binary, args, options = {}) => {
      if (binary === 'ffprobe') {
        return Promise.resolve({
          stdout: JSON.stringify({
            streams: [{ codec_type: 'video', codec_name: 'hevc' }],
          }),
        });
      }
      return new Promise((resolve, reject) => {
        const output = args[args.length - 1];
        const transcode = {
          output,
          signal: options.signal,
          ignoreAbort: false,
          finish: () => {
            fs.writeFileSync(output, 'x');
            resolve({ stdout: '' });
          },
        };
        transcodes.push(transcode);
        if (options.signal) {
          options.signal.addEventListener('abort', () => {
            if (!transcode.ignoreAbort) reject(new Error('aborted'));
          });
        }
      });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    runMediaBinary.mockReset();
  });

  const flush = () => new Promise(resolve => setTimeout(resolve, 20));

  it('stop() kills the transcode and removes its temp copy', async () => {
    const service = new CastService();
    const casting = service.cast(target, '/Movies/show.mkv');
    const rejected = expect(casting).rejects.toThrow(CAST_SUPERSEDED);
    await flush();
    expect(transcodes).toHaveLength(1);
    const [first] = transcodes;

    service.stop();

    await rejected;
    expect(first.signal.aborted).to.equal(true);
    await flush();
    expect(fs.existsSync(path.dirname(first.output))).to.equal(false);
  });

  it('a transcode that finishes after a newer cast is discarded', async () => {
    const service = new CastService();
    const casting = service.cast(target, '/Movies/first.mkv');
    const rejected = expect(casting).rejects.toThrow(CAST_SUPERSEDED);
    await flush();
    const [first] = transcodes;
    // Like a copy that completes before the kill lands.
    first.ignoreAbort = true;

    const second = service.cast(target, '/Movies/second.mkv');
    second.catch(() => {});
    await flush();
    expect(first.signal.aborted).to.equal(true);
    expect(transcodes).toHaveLength(2);

    first.finish();
    expect(fs.existsSync(first.output)).to.equal(true);
    await rejected;
    await flush();
    expect(fs.existsSync(path.dirname(first.output))).to.equal(false);
    // The newer cast is untouched and still preparing.
    expect(transcodes[1].signal.aborted).to.equal(false);
    service.stop();
    await flush();
    expect(fs.existsSync(path.dirname(transcodes[1].output))).to.equal(false);
  });
});
