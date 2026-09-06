import { describe, expect, it, vi } from 'vitest';
import PlayingView from '@/components/PlayingView.vue';

describe('PlayingView media controls', () => {
  it('starts a pan only for enlarged media and forwards drag positions', () => {
    const mediaCanvas = {
      canPanMedia: vi.fn(() => true),
      mediaPanPosition: vi.fn(() => ({ x: 12, y: -8 })),
      setMediaPan: vi.fn(),
    };
    const player = {
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => true),
      releasePointerCapture: vi.fn(),
    };
    const target = document.createElement('div');
    const context = {
      isProfessional: false,
      mediaPanPointerId: null,
      mediaPanStart: { x: 0, y: 0 },
      mediaPanOrigin: { x: 0, y: 0 },
      isMediaPanning: false,
      skipNextMediaClick: false,
      $refs: { videoCanvas: mediaCanvas },
      isMediaPanTarget: PlayingView.methods.isMediaPanTarget,
    };
    const event = {
      button: 0,
      pointerId: 7,
      clientX: 100,
      clientY: 80,
      target,
      currentTarget: player,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    PlayingView.methods.startMediaPan.call(context, event);
    PlayingView.methods.moveMediaPan.call(context, { ...event, clientX: 126, clientY: 95 });
    PlayingView.methods.endMediaPan.call(context, event);

    expect(player.setPointerCapture).toHaveBeenCalledWith(7);
    expect(mediaCanvas.setMediaPan).toHaveBeenCalledWith(38, 7);
    expect(player.releasePointerCapture).toHaveBeenCalledWith(7);
    expect(context.skipNextMediaClick).toBe(true);
  });

  it('does not interfere with player controls while deciding whether to pan', () => {
    const button = document.createElement('button');
    expect(PlayingView.methods.isMediaPanTarget(button)).toBe(false);

    const playButton = document.createElement('div');
    playButton.className = 'play-button';
    expect(PlayingView.methods.isMediaPanTarget(playButton)).toBe(false);
  });
});
