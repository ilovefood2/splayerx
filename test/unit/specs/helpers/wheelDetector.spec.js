import { ipcRenderer } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { electronWheel } from '@/plugins/input/helpers/wheelDetector';

describe('electronWheel', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('stops a touchpad phase when the gesture has no inertial wheel frames', () => {
    vi.useFakeTimers();

    ipcRenderer.emit('scroll-touch-begin');
    electronWheel.calculate({ deltaX: 20, deltaY: 0 });
    ipcRenderer.emit('scroll-touch-end');

    expect(electronWheel.lastPhase).toBe('scrolling');
    vi.advanceTimersByTime(200);
    expect(electronWheel.lastPhase).toBe('stopped');
    expect(electronWheel.isTrackPad).toBe(false);
  });
});
