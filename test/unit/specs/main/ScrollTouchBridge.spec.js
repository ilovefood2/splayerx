import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { registerScrollTouchBridge } from '../../../../src/main/helpers/scrollTouchBridge';

function createWebContents() {
  const webContents = new EventEmitter();
  webContents.isDestroyed = vi.fn(() => false);
  webContents.send = vi.fn();
  return webContents;
}

describe('scrollTouchBridge', () => {
  it('bridges modern Chromium gesture phases and wheel deltas to the renderer', () => {
    const webContents = createWebContents();
    registerScrollTouchBridge(webContents);

    webContents.emit('input-event', {}, { type: 'gestureScrollBegin' });
    webContents.emit('input-event', {}, {
      type: 'mouseWheel',
      deltaX: 2,
      deltaY: -12,
      modifiers: ['control'],
      x: 120,
      y: 80,
    });
    webContents.emit('input-event', {}, { type: 'gestureScrollEnd' });

    expect(webContents.send.mock.calls).toEqual([
      ['scroll-touch-begin'],
      ['scroll-touch-wheel', {
        ctrlKey: true,
        deltaX: 2,
        deltaY: -12,
        x: 120,
        y: 80,
      }],
      ['scroll-touch-end'],
    ]);
  });

  it('does not send after the renderer is destroyed', () => {
    const webContents = createWebContents();
    webContents.isDestroyed.mockReturnValue(true);
    registerScrollTouchBridge(webContents);

    webContents.emit('input-event', {}, { type: 'gestureScrollBegin' });

    expect(webContents.send).not.toHaveBeenCalled();
  });
});
