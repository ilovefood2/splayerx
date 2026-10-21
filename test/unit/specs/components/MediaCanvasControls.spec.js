import { afterEach, describe, expect, it, vi } from 'vitest';
import VideoCanvas from '@/containers/VideoCanvas.vue';
import { windowRectService } from '@/services/window/WindowRectService';

describe('VideoCanvas media controls', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([[1920, 1080], [1080, 1920]])('fits the window after loading %ix%i video metadata', async (width, height) => {
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
      videoWidth: width,
      videoHeight: height,
      currentTime: 0,
      play,
    };
    context.$refs = { videoCanvas: { videoElement: () => target } };

    await VideoCanvas.methods.onMetaLoaded.call(context, { target });

    expect(windowRectControl).toHaveBeenCalledOnce();
    expect(context.updateMetaInfo).toHaveBeenCalledWith({
      intrinsicWidth: width, intrinsicHeight: height, ratio: width / height,
    });
    expect(play).toHaveBeenCalledOnce();
  });

  it.each([[1080, 1920], [1920, 1080]])('uses the displayed %ix%i ratio when switching videos', (width, height) => {
    const resize = vi.spyOn(windowRectService, 'calculateWindowRect').mockReturnValue([]);
    const context = {
      videoExisted: true,
      videoWidth: width,
      videoHeight: height,
      ratio: width / height,
      winSize: [720, 405],
      winPos: [100, 100],
      winAngle: 0,
      isFullScreen: false,
    };

    VideoCanvas.methods.windowRectControl.call(context);

    const [size, , oldRect] = resize.mock.calls[0];
    expect(size[0] / size[1]).toBeCloseTo(width / height);
    expect(size[0]).toBeLessThanOrEqual(window.screen.availWidth);
    expect(size[1]).toBeLessThanOrEqual(window.screen.availHeight);
    expect(oldRect).toEqual([100, 100, 720, 405]);
  });

  it.each([
    { isFullScreen: true, ratio: 9 / 16 },
    { isFullScreen: false, ratio: NaN },
    { isFullScreen: false, ratio: 0 },
  ])('skips window resizing with fullscreen or missing video dimensions: %o', (context) => {
    const resize = vi.spyOn(windowRectService, 'calculateWindowRect');
    VideoCanvas.methods.windowRectControl.call(context);
    expect(resize).not.toHaveBeenCalled();
  });

  it('fits the current video after leaving fullscreen', () => {
    const context = { windowRectControl: vi.fn() };
    VideoCanvas.watch.isFullScreen.call(context, true);
    expect(context.windowRectControl).not.toHaveBeenCalled();
    VideoCanvas.watch.isFullScreen.call(context, false);
    expect(context.windowRectControl).toHaveBeenCalledOnce();
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
