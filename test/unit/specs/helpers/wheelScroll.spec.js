import { describe, expect, it } from 'vitest';
import {
  applyWheelScroll,
  getWheelScrollDelta,
} from '../../../../src/renderer/helpers/wheelScroll';

describe('wheelScroll', () => {
  it('preserves both touchpad scroll directions', () => {
    expect(getWheelScrollDelta({ deltaY: 42, deltaMode: 0 })).toBe(42);
    expect(getWheelScrollDelta({ deltaY: -42, deltaMode: 0 })).toBe(-42);
  });

  it('normalizes line and page wheel events', () => {
    expect(getWheelScrollDelta({ deltaY: 2, deltaMode: 1 }, 400)).toBe(32);
    expect(getWheelScrollDelta({ deltaY: -1, deltaMode: 2 }, 400)).toBe(-400);
  });

  it('updates the scroll position in either direction', () => {
    const element = { scrollTop: 200, clientHeight: 400 };

    applyWheelScroll(element, { deltaY: 50, deltaMode: 0 });
    expect(element.scrollTop).toBe(250);

    applyWheelScroll(element, { deltaY: -100, deltaMode: 0 });
    expect(element.scrollTop).toBe(150);
  });
});
