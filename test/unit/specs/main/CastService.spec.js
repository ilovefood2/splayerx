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
import { CastDevice } from '../../../../src/main/helpers/cast/CastDevice';
import {
  CAST_SUPERSEDED, CastService, canDirectCast, lanIpFor,
} from '../../../../src/main/helpers/cast/CastService';

describe('CastService discovery lifecycle', () => {
  beforeEach(() => {
    discoverWithKnown.mockReset();
    vi.spyOn(fs.promises, 'readFile').mockRejectedValue(new Error('No cache'));
    vi.spyOn(fs.promises, 'writeFile').mockResolvedValue();
  });

  afterEach(() => vi.restoreAllMocks());

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
    expect(discoverWithKnown).toHaveBeenCalledWith([], 250, expect.any(Function));
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
    expect(discoverWithKnown).toHaveBeenLastCalledWith(initial, undefined, expect.any(Function));
  });

  it('rechecks remembered TVs after restarting instead of forgetting quiet devices', async () => {
    const device = {
      id: 'tv._googlecast._tcp.local', name: 'TV', host: 'tv.local', ip: '10.0.0.62', port: 8009,
    };
    discoverWithKnown.mockResolvedValue([device]);
    await new CastService().listDevices();
    const saved = fs.promises.writeFile.mock.calls[0][1];
    fs.promises.readFile.mockResolvedValue(saved);

    await expect(new CastService().listDevices()).resolves.toEqual([device]);
    expect(discoverWithKnown).toHaveBeenLastCalledWith([device], undefined, expect.any(Function));

    // The discovery layer checks reachability; never return a dead cached TV.
    discoverWithKnown.mockResolvedValue([]);
    await expect(new CastService().listDevices()).resolves.toEqual([]);
    expect(fs.promises.writeFile).toHaveBeenCalledTimes(2);
  });

  it('ignores malformed remembered devices and shares overlapping searches', async () => {
    fs.promises.readFile.mockResolvedValue(JSON.stringify([null, {}, {
      id: 'bad', name: 'Bad', host: 'bad.local', port: -1,
    }]));
    discoverWithKnown.mockResolvedValue([]);
    const service = new CastService();
    await Promise.all([service.listDevices(), service.listDevices()]);
    expect(discoverWithKnown).toHaveBeenCalledOnce();
    expect(discoverWithKnown).toHaveBeenCalledWith([], undefined, expect.any(Function));
  });

  it('shows reachable saved TVs before the full scan finishes and keeps later discoveries', async () => {
    const saved = { id: 'saved', name: 'Saved TV', host: 'saved.local', port: 8009 };
    const added = { id: 'added', name: 'New TV', host: 'added.local', port: 8009 };
    fs.promises.readFile.mockResolvedValue(JSON.stringify([saved]));
    let finishScan;
    let offerRemembered;
    discoverWithKnown.mockImplementationOnce((known, timeout, callback) => {
      offerRemembered = callback;
      return new Promise((resolve) => { finishScan = resolve; });
    });
    const service = new CastService();
    const first = service.listDevices();
    const overlapping = service.listDevices();
    await vi.waitFor(() => expect(offerRemembered).toBeTypeOf('function'));
    offerRemembered([saved]);
    await expect(first).resolves.toEqual([saved]);
    await expect(overlapping).resolves.toEqual([saved]);
    await expect(service.listDevices()).resolves.toEqual([saved]);
    expect(discoverWithKnown).toHaveBeenCalledOnce();

    finishScan([saved, added]);
    await vi.waitFor(() => expect(fs.promises.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('cast-devices.json'), JSON.stringify([saved, added]),
    ));
    discoverWithKnown.mockResolvedValue([saved, added]);
    await expect(service.listDevices()).resolves.toEqual([saved, added]);
  });

  it('waits for the full search when saved TVs are offline', async () => {
    const offline = { id: 'offline', name: 'Offline TV', host: 'offline.local', port: 8009 };
    fs.promises.readFile.mockResolvedValue(JSON.stringify([offline]));
    let finishScan;
    discoverWithKnown.mockImplementationOnce((known, timeout, callback) => {
      callback([]);
      return new Promise((resolve) => { finishScan = resolve; });
    });
    const listing = new CastService().listDevices();
    let settled = false;
    listing.then(() => { settled = true; });
    await vi.waitFor(() => expect(finishScan).toBeTypeOf('function'));
    expect(settled).toBe(false);
    finishScan([]);
    await expect(listing).resolves.toEqual([]);
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

function get(port, headers = {}, route = '/video-0.mp4') {
  return new Promise((resolve) => {
    http.get(`http://127.0.0.1:${port}${route}`, { headers }, (response) => {
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

  it('stops the receiver, closes the media server and publishes the final position', async () => {
    const device = { stop: vi.fn() };
    const status = vi.fn();
    const closed = new Promise(resolve => service.server.once('close', resolve));
    service.device = device;
    service.lastStatus = {
      casting: true, currentTime: 23, duration: 60, paused: false,
    };
    service.on('status', status);

    service.stop();
    await closed;

    expect(device.stop).toHaveBeenCalledOnce();
    expect(service.casting).toBe(false);
    expect(service.server).toBeUndefined();
    expect(service.filePath).toBe('');
    expect(status).toHaveBeenCalledWith({
      casting: false, currentTime: 23, duration: 60, paused: true,
      ended: false, source: '', requestId: 0,
    });
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

describe('Chromecast media handoff', () => {
  const target = { id: 'tv', name: 'TV', host: '192.168.1.20', port: 8009 };
  let directory;
  let first;
  let second;
  let photo;
  let service;
  let connect;
  let load;
  let stop;
  let getStatus;
  let statuses;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'splayer-cast-handoff-test-'));
    first = path.join(directory, 'first.mp4');
    second = path.join(directory, 'second.mp4');
    photo = path.join(directory, 'photo.png');
    [first, second, photo].forEach(file => fs.writeFileSync(file, path.basename(file)));
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({
      en0: [{ family: 'IPv4', internal: false, address: '192.168.1.5', netmask: '255.255.255.0' }],
    });
    connect = vi.spyOn(CastDevice.prototype, 'connect').mockResolvedValue();
    load = vi.spyOn(CastDevice.prototype, 'load').mockResolvedValue();
    stop = vi.spyOn(CastDevice.prototype, 'stop').mockImplementation(() => {});
    getStatus = vi.spyOn(CastDevice.prototype, 'getStatus').mockResolvedValue();
    runMediaBinary.mockImplementation(async (binary, args) => {
      if (binary === 'ffprobe') return { stdout: JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'h264' }] }) };
      fs.writeFileSync(args[args.length - 1], 'normalized photo');
      return { stdout: '' };
    });
    service = new CastService();
    statuses = [];
    service.on('status', status => statuses.push(status));
  });

  afterEach(async () => {
    service.stop();
    vi.restoreAllMocks();
    runMediaBinary.mockReset();
    await fs.promises.rm(directory, { recursive: true, force: true });
  });

  it('reuses a ready TV for video → image → video and scopes every status', async () => {
    await service.cast(target, first, [], 12, 0.5, 11);
    const receiver = service.device;
    await service.cast(target, photo, [], 99, 0.5, 12);
    await service.cast(target, second, [], 0, 0.5, 13);

    expect(connect).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
    expect(service.device).toBe(receiver);
    expect(load.mock.calls.map(([media]) => media.contentType)).toEqual(['video/mp4', 'image/png', 'video/mp4']);
    expect(load.mock.calls[1][0].currentTime).toBe(0);
    expect(new Set(load.mock.calls.map(([media]) => media.url)).size).toBe(3);
    expect(statuses.map(status => [status.source, status.requestId, status.casting, status.ended])).toEqual([
      [first, 11, true, false], [photo, 12, true, false], [second, 13, true, false],
    ]);
  });

  it('does not serve the new file to a request for the previous generation', async () => {
    await service.cast(target, first, [], 0, 1, 21);
    const oldPath = new URL(load.mock.calls[0][0].url).pathname;
    await service.cast(target, photo, [], 0, 1, 22);
    const newPath = new URL(load.mock.calls[1][0].url).pathname;
    expect((await get(service.port, {}, oldPath)).statusCode).toBe(404);
    const current = await get(service.port, {}, newPath);
    expect(current.statusCode).toBe(200);
    expect(current.headers['content-type']).toBe('image/png');
    expect(current.body.toString()).toBe('photo.png');
  });

  it('keeps serving the previous file during preparation and retires it only when the next is ready', async () => {
    await service.cast(target, first, [], 0, 1, 23);
    const receiver = service.device;
    const oldPath = new URL(load.mock.calls[0][0].url).pathname;
    let finishProbe;
    runMediaBinary.mockImplementationOnce(() => new Promise((resolve) => { finishProbe = resolve; }));
    const replacement = service.cast(target, second, [], 0, 1, 24);
    await vi.waitFor(() => expect(finishProbe).toBeTypeOf('function'));
    expect((await get(service.port, {}, oldPath)).body.toString()).toBe('first.mp4');
    const pausedStatusCount = statuses.length;
    const play = vi.spyOn(receiver, 'play');
    const pause = vi.spyOn(receiver, 'pause');
    const seek = vi.spyOn(receiver, 'seek');
    service.play(); service.pause(); service.seek(99);
    expect(play).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
    expect(seek).not.toHaveBeenCalled();
    expect(statuses).toHaveLength(pausedStatusCount);
    receiver.emit('media-status', { currentTime: 999, duration: 999, paused: true, ended: true, failed: false });
    expect(statuses).toHaveLength(pausedStatusCount);
    finishProbe({ stdout: JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'h264' }] }) });
    await replacement;
    expect((await get(service.port, {}, oldPath)).statusCode).toBe(404);
    expect(service.device).toBe(receiver);
  });

  it('normalizes other shared image formats and removes the temporary copy on stop', async () => {
    const image = path.join(directory, 'photo.gif');
    fs.writeFileSync(image, 'image');
    await service.cast(target, image, [], 0, 1, 31);
    const copy = service.filePath;
    expect(runMediaBinary).toHaveBeenCalledOnce();
    expect(runMediaBinary.mock.calls[0][0]).toBe('ffmpeg');
    expect(load.mock.calls[0][0].contentType).toBe('image/png');
    expect(copy).not.toBe(image);
    service.stop();
    await vi.waitFor(() => expect(fs.existsSync(copy)).toBe(false));
    expect(fs.existsSync(image)).toBe(true);
  });

  it.each(['prepare', 'stat', 'load'])('clears casting with the current identity when %s fails', async (stage) => {
    await service.cast(target, first, [], 0, 1, 41);
    let file = second;
    if (stage === 'prepare') runMediaBinary.mockRejectedValueOnce(new Error('probe failed'));
    if (stage === 'stat') file = path.join(directory, 'missing.png');
    if (stage === 'load') load.mockRejectedValueOnce(new Error('receiver rejected media'));

    await expect(service.cast(target, file, [], 0, 1, 42)).rejects.toThrow();

    expect(service.casting).toBe(false);
    expect(statuses[statuses.length - 1]).toEqual({
      source: file, requestId: 42, casting: false, currentTime: 0, duration: 0, paused: true, ended: false,
    });
  });

  it('ignores an old status poll after replacing media on the same receiver', async () => {
    let finishOld;
    let finishNew;
    getStatus.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishNew = resolve; }));
    await service.cast(target, first, [], 0, 1, 51);
    await service.cast(target, second, [], 0, 1, 52);
    finishOld({ currentTime: 999, duration: 999, paused: true, ended: true });
    await new Promise(resolve => setImmediate(resolve));
    expect(service.statusBusy).toBe(true);
    expect(statuses[statuses.length - 1].requestId).toBe(52);
    expect(statuses[statuses.length - 1].ended).toBe(false);
    finishNew({ currentTime: 3, duration: 20, paused: false, ended: false });
    await new Promise(resolve => setImmediate(resolve));
    expect(statuses[statuses.length - 1]).toMatchObject({ source: second, requestId: 52, currentTime: 3 });
  });

  it('a late LOAD completion cannot stop or overwrite a newer receiver', async () => {
    await service.cast(target, first, [], 0, 1, 61);
    let finishOld;
    load.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    const old = service.cast(target, second, [], 0, 1, 62);
    const superseded = expect(old).rejects.toThrow(CAST_SUPERSEDED);
    await vi.waitFor(() => expect(finishOld).toBeTypeOf('function'));
    await service.cast(target, photo, [], 0, 1, 63);
    const newest = service.device;
    finishOld();
    await superseded;
    expect(service.device).toBe(newest);
    expect(stop.mock.contexts).not.toContain(newest);
    expect(statuses[statuses.length - 1]).toMatchObject({ source: photo, requestId: 63, casting: true });
  });

  it('reports a receiver fetch/decode failure with the active source identity', async () => {
    getStatus.mockResolvedValue({ currentTime: 0, duration: 0, paused: true, ended: false, failed: true });
    await service.cast(target, first, [], 0, 1, 71);
    await vi.waitFor(() => expect(service.casting).toBe(false));
    expect(statuses[statuses.length - 1]).toMatchObject({
      source: first, requestId: 71, casting: false, failed: true,
    });
    expect(service.filePath).toBe('');
  });

  it('consumes unsolicited finished and error statuses without waiting for the next poll', async () => {
    await service.cast(target, first, [], 0, 1, 72);
    service.device.emit('media-status', { currentTime: 20, duration: 20, paused: true, ended: true, failed: false });
    expect(statuses[statuses.length - 1]).toMatchObject({ source: first, requestId: 72, ended: true });
    service.device.emit('media-status', { currentTime: 20, duration: 20, paused: true, ended: false, failed: true });
    expect(service.casting).toBe(false);
    expect(statuses[statuses.length - 1]).toMatchObject({ source: first, requestId: 72, casting: false, failed: true });
  });

  it('returns a real failure if an unsolicited receiver error arrives before LOAD resolves', async () => {
    load.mockImplementationOnce(function failLoad() {
      this.emit('media-status', { currentTime: 0, duration: 0, paused: true, ended: false, failed: true });
      return Promise.resolve();
    });
    await expect(service.cast(target, first, [], 0, 1, 73)).rejects.toThrow('cast connection closed');
    expect(statuses[statuses.length - 1]).toMatchObject({ source: first, requestId: 73, casting: false, failed: true });
    expect(statuses.some(status => status.casting)).toBe(false);
  });

  it('clears the current request if pausing the previous receiver throws', async () => {
    await service.cast(target, first, [], 0, 1, 81);
    vi.spyOn(service.device, 'pause').mockImplementation(() => { throw new Error('closed socket'); });
    await expect(service.cast(target, second, [], 0, 1, 82)).rejects.toThrow('closed socket');
    expect(statuses[statuses.length - 1]).toMatchObject({ source: second, requestId: 82, casting: false });
    expect(service.casting).toBe(false);
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
