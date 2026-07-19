import { describe, expect, it } from 'vitest';
import { getVolumeWheelAdjustment } from '@/helpers/volumeWheel';

describe('volumeWheel', () => {
  it('uses the current vertical touchpad delta without waiting for legacy wheel state', () => {
    expect(getVolumeWheelAdjustment(
      { ctrlKey: false, deltaX: 1, deltaY: 20 },
      { platform: 'darwin', reverseScrolling: false },
    )).toEqual({ increase: true, step: 1.2 });

    expect(getVolumeWheelAdjustment(
      { ctrlKey: false, deltaX: -1, deltaY: -20 },
      { platform: 'darwin', reverseScrolling: false },
    )).toEqual({ increase: false, step: 1.2 });
  });

  it('honors reverse scrolling and ignores horizontal or pinch gestures', () => {
    expect(getVolumeWheelAdjustment(
      { ctrlKey: false, deltaX: 0, deltaY: 10 },
      { platform: 'darwin', reverseScrolling: true },
    )).toEqual({ increase: false, step: 0.6 });

    expect(getVolumeWheelAdjustment(
      { ctrlKey: false, deltaX: 10, deltaY: 5 },
      { platform: 'darwin', reverseScrolling: false },
    )).toBeNull();
    expect(getVolumeWheelAdjustment(
      { ctrlKey: true, deltaX: 0, deltaY: 5 },
      { platform: 'darwin', reverseScrolling: false },
    )).toBeNull();
  });

  it('limits non-macOS wheel steps', () => {
    expect(getVolumeWheelAdjustment(
      { ctrlKey: false, deltaX: 0, deltaY: -120 },
      { platform: 'win32', reverseScrolling: false },
    )).toEqual({ increase: true, step: 6 });
  });
});
