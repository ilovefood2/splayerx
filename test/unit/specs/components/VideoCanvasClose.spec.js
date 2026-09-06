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
