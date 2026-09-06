import { vi } from 'vitest';
import BaseVideoPlayer from '@/components/PlayingView/BaseVideoPlayer.vue';
import VideoCanvas from '@/containers/VideoCanvas.vue';
import { playInfoStorageService } from '@/services/storage/PlayInfoStorageService';

describe('playback intent during delayed network loads', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([false, true])('uses the latest pause state after a seek (initially paused: %s)', async (initialPaused) => {
    let metadataLoaded;
    const video = {
      addEventListener: (event, callback) => { metadataLoaded = callback; },
      play: vi.fn().mockResolvedValue(),
      load: vi.fn(),
    };
    const context = {
      $refs: { video },
      src: 'http://127.0.0.1:1234/compat/token/movie.mp4?start=0',
      compatibilityGeneration: 0,
      paused: initialPaused,
    };

    BaseVideoPlayer.methods.restartCompatibilityStream.call(context, 60);
    context.paused = !initialPaused;
    await metadataLoaded();

    expect(video.play).toHaveBeenCalledTimes(initialPaused ? 1 : 0);
  });

  function metadataContext() {
    const target = {
      duration: 120, videoWidth: 320, videoHeight: 180, play: vi.fn(),
    };
    const context = {
      $refs: { videoCanvas: { videoElement: () => target } },
      $bus: { $emit: vi.fn() },
      audioCtx: {
        createGain: () => ({ connect() {} }),
        createMediaElementSource: () => ({ connect() {} }),
      },
      videoId: 1,
      originSrc: '/Volumes/share/movie.mp4',
      paused: false,
      volume: 1,
      videoConfigInitialize: vi.fn(),
      updateMetaInfo: vi.fn(),
      changeWindowRotate: vi.fn(),
      applyMediaAppearance: vi.fn(),
      $emit: vi.fn(),
    };
    return { context, target };
  }

  it('does not resume after pausing while saved playback metadata is loading', async () => {
    let finishRead;
    vi.spyOn(playInfoStorageService, 'getMediaItem').mockReturnValue(new Promise((resolve) => {
      finishRead = resolve;
    }));
    const { context, target } = metadataContext();
    const loaded = VideoCanvas.methods.onMetaLoaded.call(context, { target });
    context.paused = true;
    finishRead({});
    await loaded;

    expect(target.play).not.toHaveBeenCalled();
    expect(context.videoConfigInitialize.mock.calls[0][0].paused).not.to.equal(false);
  });

  it('ignores saved metadata for a video element that has been replaced', async () => {
    let finishRead;
    vi.spyOn(playInfoStorageService, 'getMediaItem').mockReturnValue(new Promise((resolve) => {
      finishRead = resolve;
    }));
    const { context, target } = metadataContext();
    const loaded = VideoCanvas.methods.onMetaLoaded.call(context, { target });
    context.$refs.videoCanvas.videoElement = () => ({});
    finishRead({});
    await loaded;

    expect(context.videoConfigInitialize).not.toHaveBeenCalled();
    expect(target.play).not.toHaveBeenCalled();
  });
});
