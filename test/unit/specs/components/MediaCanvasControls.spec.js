import { describe, expect, it, vi } from 'vitest';
import VideoCanvas from '@/containers/VideoCanvas.vue';

describe('VideoCanvas media controls', () => {
  it('keeps the window size when video metadata loads', async () => {
    const windowRectControl = vi.fn();
    const connect = vi.fn();
    const play = vi.fn();
    const context = {
      audioCtx: {
        createGain: () => ({ gain: {}, connect }),
        createMediaElementSource: () => ({ connect }),
        destination: {},
      },
      videoId: NaN,
      originSrc: '/library/movie.mp4',
      volume: 1,
      muted: false,
      nowRate: 1,
      videoElement: null,
      lastAudioTrackId: 0,
      gainNode: null,
      enableVideoInfoStore: false,
      $bus: { $emit: vi.fn() },
      $emit: vi.fn(),
      videoConfigInitialize: vi.fn(),
      updateMetaInfo: vi.fn(),
      changeWindowRotate: vi.fn(),
      applyMediaAppearance: vi.fn(),
      windowRectControl,
    };
    const target = {
      duration: 60,
      videoWidth: 1920,
      videoHeight: 1080,
      currentTime: 0,
      play,
    };
    context.$refs = { videoCanvas: { videoElement: () => target } };

    await VideoCanvas.methods.onMetaLoaded.call(context, { target });

    expect(windowRectControl).not.toHaveBeenCalled();
    expect(play).toHaveBeenCalledOnce();
  });

  it('applies a pinch zoom without depending on the media type', () => {
    const changeWindowRotate = vi.fn();
    const context = {
      mediaZoom: 1,
      mediaPanX: 0,
      mediaPanY: 0,
      winAngle: 0,
      changeWindowRotate,
    };

    VideoCanvas.methods.handleMediaPinch.call(context, {
      ctrlKey: true,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      deltaY: -20,
    });

    expect(context.mediaZoom).toBeGreaterThan(1);
    expect(changeWindowRotate).toHaveBeenCalledWith(0);
  });

  it('keeps panning inside the enlarged media bounds', () => {
    const context = {
      mediaZoom: 2,
      mediaPanX: 0,
      mediaPanY: 0,
      $el: {
        getBoundingClientRect: () => ({ width: 100, height: 100 }),
      },
      mediaContainerElement: () => ({
        getBoundingClientRect: () => ({ width: 200, height: 300 }),
      }),
      mediaPanBounds: VideoCanvas.methods.mediaPanBounds,
    };

    const pan = VideoCanvas.methods.clampMediaPan.call(context, 90, -140);

    expect(pan).toEqual({ x: 50, y: -100 });
  });

  it('uses a CSS brightness filter for visual media', () => {
    const media = {
      style: {
        removeProperty: vi.fn(),
        setProperty: vi.fn(),
      },
    };
    const context = {
      brightness: 1.4,
      mediaContainerElement: () => media,
    };

    VideoCanvas.methods.applyMediaAppearance.call(context);

    expect(media.style.setProperty).toHaveBeenCalledWith('filter', 'brightness(1.4)');
  });
});
