import { describe, expect, it } from 'vitest';
import { isMediaPinchGesture, zoomMediaFromPinch } from '@/helpers/mediaZoom';

describe('mediaZoom', () => {
  it('recognizes the Ctrl-modified wheel events emitted for trackpad pinches', () => {
    expect(isMediaPinchGesture({ ctrlKey: true, deltaY: -2 })).toBe(true);
    expect(isMediaPinchGesture({ ctrlKey: false, deltaY: -2 })).toBe(false);
    expect(isMediaPinchGesture({ ctrlKey: true, deltaY: 0 })).toBe(false);
  });

  it('zooms in and out smoothly from a pinch wheel delta', () => {
    const zoomedIn = zoomMediaFromPinch(1, {
      ctrlKey: true,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      deltaY: -10,
    });
    const zoomedOut = zoomMediaFromPinch(zoomedIn, {
      ctrlKey: true,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      deltaY: 10,
    });

    expect(zoomedIn).toBeGreaterThan(1);
    expect(zoomedOut).toBeCloseTo(1);
  });

  it('keeps media at its fitted size or below the maximum zoom', () => {
    expect(zoomMediaFromPinch(1, {
      ctrlKey: true,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      deltaY: 100,
    })).toBe(1);
    expect(zoomMediaFromPinch(8, {
      ctrlKey: true,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      deltaY: -100,
    })).toBe(8);
  });
});
