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
      switchingLock: false,
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
      switchingLock: false,
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
      switchingLock: false,
      clearImageAutoplayTimer: VideoCanvas.methods.clearImageAutoplayTimer,
      scheduleImageAutoplay: VideoCanvas.methods.scheduleImageAutoplay,
      $bus: { $emit: emit },
    };

    VideoCanvas.watch.playingList.call(context, context.playingList);
    vi.advanceTimersByTime(3000);

    expect(emit).toHaveBeenCalledWith('next-video');
  });
});
