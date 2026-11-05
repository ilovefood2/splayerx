import { vi } from 'vitest';
import VideoCanvas from '@/containers/VideoCanvas.vue';

describe('VideoCanvas window cleanup', () => {
  it('hides only the player window being closed while playback state is saved', async () => {
    const hideCurrentWindow = vi.fn();
    const hideApplication = vi.fn();
    const closeWindow = vi.spyOn(window, 'close').mockImplementation(() => {});
    const currentWebContents = { audioMuted: false };
    const context = {
      asyncTasksDone: false,
      closeTasksStarted: false,
      needToRestore: false,
      quit: false,
      videoId: 42,
      $electron: {
        remote: {
          app: { hide: hideApplication },
          getCurrentWindow: () => ({ hide: hideCurrentWindow }),
          getCurrentWebContents: () => currentWebContents,
        },
      },
      $store: { dispatch: vi.fn() },
      handleLeaveVideo: vi.fn().mockResolvedValue(),
      removeAllAudioTrack: vi.fn(),
    };
    const event = {};

    VideoCanvas.methods.beforeUnloadHandler.call(context, event);
    VideoCanvas.methods.beforeUnloadHandler.call(context, event);
    await vi.waitFor(() => expect(closeWindow).toHaveBeenCalledOnce());

    expect(event.returnValue).to.equal(false);
    expect(hideCurrentWindow).toHaveBeenCalledOnce();
    expect(hideApplication).not.toHaveBeenCalled();
    expect(currentWebContents.audioMuted).to.equal(true);
    expect(context.removeAllAudioTrack).toHaveBeenCalledOnce();
    expect(context.handleLeaveVideo).toHaveBeenCalledOnce();
    expect(context.$store.dispatch).toHaveBeenCalledWith(
      'SRC_SET',
      { src: '', mediaHash: '', id: NaN },
    );
    expect(context.asyncTasksDone).to.equal(true);
  });
});

describe('VideoCanvas previous-folder navigation', () => {
  it('uses the folder scan when playing a folder video', async () => {
    const openPreviousFolderVideo = vi.fn().mockResolvedValue();
    const context = {
      switchingLock: false,
      isFolderList: true,
      openPreviousFolderVideo,
    };

    await VideoCanvas.methods.playPreviousVideo.call(context);

    expect(openPreviousFolderVideo).toHaveBeenCalledOnce();
  });

  it('opens the preceding file from the refreshed folder list', async () => {
    const list = ['/videos/one.mp4', '/videos/two.mp4', '/videos/three.mp4'];
    const openFolderVideo = vi.fn().mockResolvedValue();
    const context = {
      originSrc: list[1],
      playlistLoop: false,
      getCurrentFolderVideos: vi.fn().mockResolvedValue(list),
      openFolderVideo,
      $bus: { $emit: vi.fn() },
    };

    await VideoCanvas.methods.openPreviousFolderVideo.call(context);

    expect(openFolderVideo).toHaveBeenCalledWith(list[0], list);
    expect(context.$bus.$emit).not.toHaveBeenCalled();
  });

  it('rewinds at the first file unless folder looping is enabled', async () => {
    const list = ['/videos/one.mp4', '/videos/two.mp4'];
    const context = {
      originSrc: list[0],
      playlistLoop: false,
      getCurrentFolderVideos: vi.fn().mockResolvedValue(list),
      openFolderVideo: vi.fn(),
      $bus: { $emit: vi.fn() },
    };

    await VideoCanvas.methods.openPreviousFolderVideo.call(context);

    expect(context.openFolderVideo).not.toHaveBeenCalled();
    expect(context.$bus.$emit).toHaveBeenCalledWith('seek', 0);
  });

  it('wraps to the last folder file when folder looping is enabled', async () => {
    const list = ['/videos/one.mp4', '/videos/two.mp4', '/videos/three.mp4'];
    const openFolderVideo = vi.fn().mockResolvedValue();
    const context = {
      originSrc: list[0],
      playlistLoop: true,
      getCurrentFolderVideos: vi.fn().mockResolvedValue(list),
      openFolderVideo,
      $bus: { $emit: vi.fn() },
    };

    await VideoCanvas.methods.openPreviousFolderVideo.call(context);

    expect(openFolderVideo).toHaveBeenCalledWith(list[2], list);
    expect(context.$bus.$emit).not.toHaveBeenCalled();
  });
});

describe('VideoCanvas image folder autoplay', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('advances to the next mixed-media item after about three seconds', () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const context = {
      isImage: true,
      originSrc: '/library/01-cover.jpg',
      playingList: ['/library/01-cover.jpg', '/library/02-video.mp4'],
      imageAutoplayTimer: 0,
      imageAutoplayDeadline: 0,
      imageAutoplayRemaining: 3000,
      imageAutoplayPausedByUser: false,
      switchingLock: false,
      canAutoplayImage: VideoCanvas.methods.canAutoplayImage,
      clearImageAutoplayTimer: VideoCanvas.methods.clearImageAutoplayTimer,
      $bus: { $emit: emit },
    };

    VideoCanvas.methods.scheduleImageAutoplay.call(context);
    vi.advanceTimersByTime(2999);
    expect(emit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(emit).toHaveBeenCalledWith('next-video');
  });

  it('does not autoplay a standalone image', () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const context = {
      isImage: true,
      originSrc: '/library/cover.jpg',
      playingList: ['/library/cover.jpg'],
      imageAutoplayTimer: 0,
      imageAutoplayDeadline: 0,
      imageAutoplayRemaining: 3000,
      imageAutoplayPausedByUser: false,
      switchingLock: false,
      canAutoplayImage: VideoCanvas.methods.canAutoplayImage,
      clearImageAutoplayTimer: VideoCanvas.methods.clearImageAutoplayTimer,
      $bus: { $emit: emit },
    };

    VideoCanvas.methods.scheduleImageAutoplay.call(context);
    vi.advanceTimersByTime(3000);

    expect(emit).not.toHaveBeenCalled();
  });

  it('starts the first image timer when its playlist arrives after loading', () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const context = {
      isImage: true,
      originSrc: '/library/01-cover.jpg',
      playingList: ['/library/01-cover.jpg', '/library/02-video.mp4'],
      imageElement: {},
      imageAutoplayTimer: 0,
      imageAutoplayDeadline: 0,
      imageAutoplayRemaining: 3000,
      imageAutoplayPausedByUser: false,
      switchingLock: false,
      canAutoplayImage: VideoCanvas.methods.canAutoplayImage,
      clearImageAutoplayTimer: VideoCanvas.methods.clearImageAutoplayTimer,
      scheduleImageAutoplay: VideoCanvas.methods.scheduleImageAutoplay,
      startImageAutoplay: VideoCanvas.methods.startImageAutoplay,
      advancePastFailedMediaIfPossible:
        VideoCanvas.methods.advancePastFailedMediaIfPossible,
      play: vi.fn(),
      $bus: { $emit: emit },
    };

    VideoCanvas.watch.playingList.call(context, context.playingList);
    vi.advanceTimersByTime(3000);

    expect(emit).toHaveBeenCalledWith('next-video');
  });

  it('pauses the image transition and resumes from the remaining time', () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const play = vi.fn();
    const pause = vi.fn();
    const context = {
      isImage: true,
      originSrc: '/library/01-cover.jpg',
      playingList: ['/library/01-cover.jpg', '/library/02-video.mp4'],
      imageAutoplayTimer: 0,
      imageAutoplayDeadline: 0,
      imageAutoplayRemaining: 3000,
      imageAutoplayPausedByUser: false,
      switchingLock: false,
      canAutoplayImage: VideoCanvas.methods.canAutoplayImage,
      clearImageAutoplayTimer: VideoCanvas.methods.clearImageAutoplayTimer,
      scheduleImageAutoplay: VideoCanvas.methods.scheduleImageAutoplay,
      startImageAutoplay: VideoCanvas.methods.startImageAutoplay,
      pauseImageAutoplay: VideoCanvas.methods.pauseImageAutoplay,
      resumeImageAutoplay: VideoCanvas.methods.resumeImageAutoplay,
      play,
      pause,
      $bus: { $emit: emit },
    };

    VideoCanvas.methods.startImageAutoplay.call(context);
    vi.advanceTimersByTime(1000);
    VideoCanvas.methods.pauseImageAutoplay.call(context);
    expect(pause).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(3000);
    expect(emit).not.toHaveBeenCalled();

    VideoCanvas.methods.resumeImageAutoplay.call(context);
    vi.advanceTimersByTime(1999);
    expect(emit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(emit).toHaveBeenCalledWith('next-video');
    expect(play).toHaveBeenCalledTimes(2);
  });
});

describe('VideoCanvas failed media navigation', () => {
  it('skips an unplayable item and continues the recursive queue', () => {
    const emit = vi.fn();
    const context = {
      originSrc: '/library/chapter/broken.mp4',
      playingList: [
        '/library/cover.jpg',
        '/library/chapter/broken.mp4',
        '/library/next/photo.jpg',
      ],
      failedMediaSrc: '',
      mediaErrorAdvanced: false,
      switchingLock: true,
      advancePastFailedMediaIfPossible:
        VideoCanvas.methods.advancePastFailedMediaIfPossible,
      $bus: { $emit: emit },
    };

    VideoCanvas.methods.handleMediaPlaybackError.call(context);

    expect(context.switchingLock).to.equal(false);
    expect(emit).toHaveBeenCalledWith('next-video');
  });

  it('continues once a delayed playlist arrives after the error', () => {
    const emit = vi.fn();
    const context = {
      originSrc: '/library/broken.mp4',
      playingList: [],
      failedMediaSrc: '',
      mediaErrorAdvanced: false,
      switchingLock: true,
      isImage: false,
      imageElement: null,
      advancePastFailedMediaIfPossible:
        VideoCanvas.methods.advancePastFailedMediaIfPossible,
      $bus: { $emit: emit },
    };

    VideoCanvas.methods.handleMediaPlaybackError.call(context);
    expect(emit).not.toHaveBeenCalled();

    context.playingList = ['/library/broken.mp4', '/library/sub/next.png'];
    VideoCanvas.watch.playingList.call(context, context.playingList);

    expect(emit).toHaveBeenCalledWith('next-video');
  });
});

describe('VideoCanvas cast media handoff', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function imageContext() {
    const target = { naturalWidth: 600, naturalHeight: 400 };
    const context = {
      ...VideoCanvas.data(),
      isImage: true,
      casting: true,
      castPaused: false,
      paused: true,
      switchingLock: true,
      originSrc: '/library/photo.jpg',
      playingList: ['/library/photo.jpg', '/library/next.mp4'],
      $refs: { imageCanvas: target },
      $bus: { $emit: vi.fn() },
      $emit: vi.fn(),
      $electron: { ipcRenderer: { send: vi.fn() } },
      updateVideoCurrentTime: vi.fn(),
      updateMetaInfo: vi.fn(),
      changeWindowRotate: vi.fn(),
      applyMediaAppearance: vi.fn(),
      windowRectControl: vi.fn(),
    };
    context.play = vi.fn(() => { context.paused = false; });
    context.pause = vi.fn(() => { context.paused = true; });
    context.updateCastPaused = vi.fn((value) => { context.castPaused = value; });
    context.videoConfigInitialize = vi.fn(config => Object.assign(context, config));
    [
      'canAutoplayImage', 'clearImageAutoplayTimer', 'scheduleImageAutoplay',
      'startImageAutoplay', 'pauseImageAutoplay', 'resumeImageAutoplay',
      'onImageLoaded', 'onCastMediaLoading', 'onCastMediaReady', 'onCastMediaStopped',
      'togglePlayback', 'handleMediaPlaybackError', 'advancePastFailedMediaIfPossible',
    ].forEach((name) => { context[name] = VideoCanvas.methods[name]; });
    return { context, target };
  }

  it.each([true, false])('starts the image interval only after both TV and image are ready (TV first: %s)', (tvFirst) => {
    const { context, target } = imageContext();
    if (tvFirst) context.onCastMediaReady(context.originSrc);
    else context.onImageLoaded({ target });
    vi.advanceTimersByTime(5000);
    expect(context.$bus.$emit).not.toHaveBeenCalledWith('next-video');

    if (tvFirst) context.onImageLoaded({ target });
    else context.onCastMediaReady(context.originSrc);
    expect(context.switchingLock).toBe(false);
    expect(context.paused).toBe(false);
    expect(context.castPaused).toBe(false);
    vi.advanceTimersByTime(2999);
    expect(context.$bus.$emit).not.toHaveBeenCalledWith('next-video');
    vi.advanceTimersByTime(1);
    expect(context.$bus.$emit).toHaveBeenCalledWith('next-video');
  });

  it('stops an existing local image timer while the first cast is loading', () => {
    const { context, target } = imageContext();
    context.casting = false;
    context.onImageLoaded({ target });
    vi.advanceTimersByTime(1000);
    context.casting = true;
    context.onCastMediaLoading(context.originSrc);
    vi.advanceTimersByTime(5000);
    expect(context.$bus.$emit).not.toHaveBeenCalledWith('next-video');
    expect(context.imageAutoplayPausedByUser).toBe(false);
    context.onCastMediaReady(context.originSrc);
    vi.advanceTimersByTime(3000);
    expect(context.$bus.$emit).toHaveBeenCalledWith('next-video');
  });

  it('keeps cast controls paused when casting an already-paused local image', () => {
    const { context, target } = imageContext();
    context.casting = false;
    context.onImageLoaded({ target });
    context.pauseImageAutoplay();
    context.casting = true;
    context.castPaused = false;
    context.onCastMediaLoading(context.originSrc);
    context.onCastMediaReady(context.originSrc);
    vi.advanceTimersByTime(5000);
    expect(context.paused).toBe(true);
    expect(context.castPaused).toBe(true);
    expect(context.$bus.$emit).not.toHaveBeenCalledWith('next-video');
  });

  it('preserves an image pause through loading and records a resume before TV readiness', () => {
    const { context, target } = imageContext();
    context.togglePlayback();
    expect(context.imageAutoplayPausedByUser).toBe(true);
    expect(context.castPaused).toBe(true);
    context.onImageLoaded({ target });
    expect(context.imageAutoplayPausedByUser).toBe(true);
    context.togglePlayback();
    expect(context.imageAutoplayPausedByUser).toBe(false);
    expect(context.castPaused).toBe(false);
    expect(context.imageAutoplayTimer).toBe(0);
    context.onCastMediaReady(context.originSrc);
    vi.advanceTimersByTime(3000);
    expect(context.$bus.$emit).toHaveBeenCalledWith('next-video');
    expect(context.$electron.ipcRenderer.send).not.toHaveBeenCalled();
  });

  it('does not resume a user-paused image when the TV becomes ready before image loading', () => {
    const { context, target } = imageContext();
    context.pauseImageAutoplay();
    context.onCastMediaReady(context.originSrc);
    context.onImageLoaded({ target });
    vi.advanceTimersByTime(10000);
    expect(context.paused).toBe(true);
    expect(context.castPaused).toBe(true);
    expect(context.$bus.$emit).not.toHaveBeenCalledWith('next-video');
  });

  it.each([true, false])('continues image autoplay locally after cast failure (image already loaded: %s)', (loaded) => {
    const { context, target } = imageContext();
    if (loaded) context.onImageLoaded({ target });
    context.casting = false;
    context.onCastMediaStopped({ resume: true });
    expect(context.switchingLock).toBe(false);
    expect(context.castMediaReady).toBe(false);
    if (!loaded) {
      expect(context.imageAutoplayTimer).toBe(0);
      context.onImageLoaded({ target });
    }
    vi.advanceTimersByTime(3000);
    expect(context.$bus.$emit).toHaveBeenCalledWith('next-video');
  });

  it('keeps the image timer paused after an explicit cast stop', () => {
    const { context, target } = imageContext();
    context.onCastMediaReady(context.originSrc);
    context.onImageLoaded({ target });
    vi.advanceTimersByTime(1000);
    context.casting = false;
    context.onCastMediaStopped({ resume: false });
    vi.advanceTimersByTime(5000);
    expect(context.paused).toBe(true);
    expect(context.imageAutoplayPausedByUser).toBe(true);
    expect(context.$bus.$emit).not.toHaveBeenCalledWith('next-video');
  });

  it('unlocks video advancement on TV readiness and resumes local video after failure', () => {
    const { context } = imageContext();
    context.isImage = false;
    context.onCastMediaReady('/library/old.mp4');
    expect(context.switchingLock).toBe(true);
    context.onCastMediaReady(context.originSrc);
    expect(context.switchingLock).toBe(false);
    expect(context.play).not.toHaveBeenCalled();
    context.casting = false;
    context.onCastMediaStopped({ resume: true });
    expect(context.play).toHaveBeenCalledOnce();
  });

  it('records a local decoder failure without skipping the TV file, then permits local fallback to advance', () => {
    const { context } = imageContext();
    context.isImage = false;
    context.handleMediaPlaybackError();
    expect(context.failedMediaSrc).toBe(context.originSrc);
    expect(context.$bus.$emit).not.toHaveBeenCalledWith('next-video');
    context.casting = false;
    context.onCastMediaStopped({ resume: true });
    expect(context.$bus.$emit).toHaveBeenCalledWith('next-video');
    expect(context.play).not.toHaveBeenCalled();
  });

  it.each([false, true])('times the TV photo when the local preview fails (TV ready first: %s)', (tvFirst) => {
    const { context, target } = imageContext();
    if (tvFirst) context.onCastMediaReady(context.originSrc);
    VideoCanvas.methods.handleImageError.call(context, { target });
    if (!tvFirst) context.onCastMediaReady(context.originSrc);
    expect(context.imageElement).toBeNull();
    vi.advanceTimersByTime(1000);
    VideoCanvas.methods.handleImageError.call(context, { target });
    vi.advanceTimersByTime(1999);
    expect(context.$bus.$emit).not.toHaveBeenCalledWith('next-video');
    vi.advanceTimersByTime(1);
    expect(context.$bus.$emit).toHaveBeenCalledWith('next-video');
  });

  it('ignores a stale video decoder error from a replaced player element', () => {
    const { context } = imageContext();
    context.isImage = false;
    context.$refs.videoCanvas = { videoElement: () => ({}) };
    context.handleMediaPlaybackError({ code: 3 }, {});
    expect(context.failedMediaSrc).toBe('');
    expect(context.$bus.$emit).not.toHaveBeenCalledWith('next-video');
  });

  it.each([false, true])('ignores a late image load after a newer source replaced it (new image: %s)', (isImage) => {
    const { context, target } = imageContext();
    context.isImage = isImage;
    context.$refs.imageCanvas = {};
    context.onImageLoaded({ target });
    expect(context.videoConfigInitialize).not.toHaveBeenCalled();
    expect(context.imageElement).toBeNull();
  });

  it.each([false, true])('ignores a late image error after a newer source replaced it (new image: %s)', (isImage) => {
    const { context, target } = imageContext();
    context.isImage = isImage;
    context.$refs.imageCanvas = {};
    context.handleMediaPlaybackError = vi.fn();
    VideoCanvas.methods.handleImageError.call(context, { target });
    expect(context.handleMediaPlaybackError).not.toHaveBeenCalled();
  });
});
