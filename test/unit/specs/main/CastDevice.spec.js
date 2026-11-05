import { afterEach, describe, expect, it, vi } from 'vitest';
import { CastDevice } from '../../../../src/main/helpers/cast/CastDevice';

const mediaNamespace = 'urn:x-cast:com.google.cast.media';
function connectedDevice() {
  const device = new CastDevice('127.0.0.1');
  device.transportId = 'receiver-app';
  device.mediaUrl = 'http://sender/video-1.mp4';
  return device;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('CastDevice media handoff', () => {
  it('loads photos without a video timeline or subtitle track', async () => {
    const device = connectedDevice();
    const request = vi.spyOn(device, 'request').mockResolvedValue({
      type: 'MEDIA_STATUS', status: [{ mediaSessionId: 10 }],
    });
    await device.load({
      url: 'http://sender/video-2.png', contentType: 'image/png', currentTime: 100,
      title: 'Photo', subtitleUrl: 'http://sender/subtitle.vtt',
    });
    expect(request).toHaveBeenCalledWith(mediaNamespace, expect.objectContaining({
      type: 'LOAD', currentTime: 0,
      media: expect.objectContaining({
        contentType: 'image/png', streamType: 'NONE',
        metadata: { type: 4, metadataType: 4, title: 'Photo' },
        tracks: undefined,
      }),
    }), 'receiver-app');
  });

  it('does not query a previous media session when the next LOAD omits its session ID', async () => {
    const device = connectedDevice();
    device.mediaSessionId = 5;
    const request = vi.spyOn(device, 'request')
      .mockResolvedValueOnce({ type: 'MEDIA_STATUS', status: [] })
      .mockResolvedValueOnce({ status: [{ mediaSessionId: 6, playerState: 'PLAYING' }] });
    await device.load({ url: 'http://sender/video-2.mp4', contentType: 'video/mp4' });
    expect(request.mock.calls[1][1]).toEqual({ type: 'GET_STATUS' });
    expect(device.mediaSessionId).toBe(6);
  });

  it.each(['LOAD_FAILED', 'INVALID_REQUEST', 'INVALID_PLAYER_STATE'])('rejects a receiver refusing LOAD with %s', async (type) => {
    const device = connectedDevice();
    vi.spyOn(device, 'request').mockResolvedValue({ type });
    await expect(device.load({ url: 'http://sender/video-2.png', contentType: 'image/png' }))
      .rejects.toThrow('device refused the media');
  });

  it.each(['FINISHED', 'CANCELLED', 'INTERRUPTED', 'ERROR'])('recognizes only a natural media finish: %s', async (idleReason) => {
    const device = connectedDevice();
    vi.spyOn(device, 'request').mockResolvedValue({ status: [{
      mediaSessionId: 10, currentTime: 60, playerState: 'IDLE', idleReason,
      media: { duration: 60, contentId: device.mediaUrl },
    }] });
    expect(await device.getStatus()).toEqual({
      currentTime: 60, duration: 60, paused: true, ended: idleReason === 'FINISHED',
      failed: idleReason === 'ERROR',
    });
  });

  it('ignores a GET_STATUS reply for media replaced while the request was in flight', async () => {
    const device = connectedDevice();
    let finishOld;
    vi.spyOn(device, 'request')
      .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockResolvedValueOnce({ status: [{ mediaSessionId: 11 }] });
    const oldStatus = device.getStatus();
    await device.load({ url: 'http://sender/video-2.mp4', contentType: 'video/mp4' });
    finishOld({ status: [{
      mediaSessionId: 10, playerState: 'IDLE', idleReason: 'FINISHED',
      media: { contentId: 'http://sender/video-1.mp4' },
    }] });
    await expect(oldStatus).resolves.toBeUndefined();
    expect(device.mediaSessionId).toBe(11);
  });

  it('does not replace the active session ID with a delayed status for the previous file', () => {
    const device = connectedDevice();
    device.mediaUrl = 'http://sender/video-2.mp4';
    device.mediaSessionId = 11;
    for (const media of [{ contentId: 'http://sender/video-1.mp4' }, undefined]) {
      device.onFrame({ namespace: mediaNamespace, payload: JSON.stringify({
        type: 'MEDIA_STATUS', status: [{ mediaSessionId: 10, media }],
      }) });
    }
    expect(device.mediaSessionId).toBe(11);
  });

  it('normalizes an unsolicited natural finish so it is not lost between polls', () => {
    const device = connectedDevice();
    const status = vi.fn();
    device.on('media-status', status);
    device.onFrame({ namespace: mediaNamespace, payload: JSON.stringify({
      type: 'MEDIA_STATUS', status: [{ mediaSessionId: 10, playerState: 'IDLE', idleReason: 'FINISHED', currentTime: 20, media: { contentId: device.mediaUrl, duration: 20 } }],
    }) });
    expect(status).toHaveBeenCalledWith({ currentTime: 20, duration: 20, paused: true, ended: true, failed: false });
  });

  it('rejects pending control requests immediately when stopped', async () => {
    vi.useFakeTimers();
    const device = connectedDevice();
    const request = device.getStatus();
    const stopped = expect(request).rejects.toThrow('cast connection closed');
    device.stop();
    await stopped;
    expect(vi.getTimerCount()).toBe(0);
    expect(device.pending.size).toBe(0);
  });
});
