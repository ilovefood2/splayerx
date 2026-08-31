import { beforeEach, describe, expect, it, vi } from 'vitest';

const discoverWithKnown = vi.hoisted(() => vi.fn());

vi.mock('../../../../src/main/helpers/cast/CastDiscovery', () => ({
  discoverWithKnown,
}));

vi.mock('../../../../src/main/helpers/ffmpeg', () => ({
  runMediaBinary: vi.fn(),
}));

import { CastService, canDirectCast } from '../../../../src/main/helpers/cast/CastService';

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
