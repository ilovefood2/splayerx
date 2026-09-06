import { describe, expect, it, vi } from 'vitest';
import VideoCanvas from '@/containers/VideoCanvas.vue';

describe('VideoCanvas single-file loop', () => {
  it('does not let the folder autoplay fallback advance a looping video', () => {
    const emit = vi.fn();
    const context = {
      loop: true,
      isFolderList: true,
      switchingLock: false,
      folderAutoplayFallbackFired: false,
      $bus: { $emit: emit },
    };

    VideoCanvas.methods.handleVideoTimeupdate.call(context, {
      target: { duration: 60, currentTime: 59.9 },
    });

    expect(emit).not.toHaveBeenCalled();
  });

  it('still advances a folder video when single-file loop is off', () => {
    const emit = vi.fn();
    const context = {
      loop: false,
      isFolderList: true,
      switchingLock: false,
      folderAutoplayFallbackFired: false,
      $bus: { $emit: emit },
    };

    VideoCanvas.methods.handleVideoTimeupdate.call(context, {
      target: { duration: 60, currentTime: 59.9 },
    });

    expect(emit).toHaveBeenCalledWith('next-video');
  });

  it('ignores the ended event while looping the current video', () => {
    const emit = vi.fn();
    const context = {
      loop: true,
      $bus: { $emit: emit },
    };

    VideoCanvas.methods.handleVideoEnded.call(context);

    expect(emit).not.toHaveBeenCalled();
  });

  it('advances on ended when single-file loop is off', () => {
    const emit = vi.fn();
    const context = {
      loop: false,
      $bus: { $emit: emit },
    };

    VideoCanvas.methods.handleVideoEnded.call(context);

    expect(emit).toHaveBeenCalledWith('next-video');
  });

  it('stops image slideshow advancement while looping one file', () => {
    const context = {
      isImage: true,
      loop: true,
      playingList: ['/library/one.jpg', '/library/two.jpg'],
    };

    expect(VideoCanvas.methods.canAutoplayImage.call(context)).to.equal(false);
  });
});
