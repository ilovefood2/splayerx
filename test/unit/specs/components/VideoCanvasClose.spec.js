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
