import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import {
  isPreferenceCloseShortcut,
  registerPreferenceWindowControls,
} from '../../../../src/main/helpers/preferenceWindowControls';

function createPreferenceWindow() {
  const webContents = new EventEmitter();
  const preferenceWindow = {
    webContents,
    close: vi.fn(),
    isDestroyed: vi.fn(() => false),
  };
  return preferenceWindow;
}

describe('preferenceWindowControls', () => {
  it('recognizes Escape and the platform close shortcut', () => {
    expect(isPreferenceCloseShortcut({ type: 'keyDown', key: 'Escape' }, 'darwin')).toBe(true);
    expect(isPreferenceCloseShortcut({ type: 'keyDown', key: 'w', meta: true }, 'darwin')).toBe(true);
    expect(isPreferenceCloseShortcut({ type: 'keyDown', key: 'W', control: true }, 'win32')).toBe(true);
    expect(isPreferenceCloseShortcut({ type: 'keyDown', key: 'w' }, 'darwin')).toBe(false);
    expect(isPreferenceCloseShortcut({ type: 'keyUp', key: 'Escape' }, 'darwin')).toBe(false);
  });

  it('closes the preference window and consumes the keyboard event', () => {
    const preferenceWindow = createPreferenceWindow();
    const event = { preventDefault: vi.fn() };
    registerPreferenceWindowControls(preferenceWindow, 'darwin');

    preferenceWindow.webContents.emit('before-input-event', event, {
      type: 'keyDown',
      key: 'w',
      meta: true,
    });

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(preferenceWindow.close).toHaveBeenCalledOnce();
  });

  it('does not close an already destroyed preference window', () => {
    const preferenceWindow = createPreferenceWindow();
    preferenceWindow.isDestroyed.mockReturnValue(true);
    registerPreferenceWindowControls(preferenceWindow, 'darwin');

    preferenceWindow.webContents.emit('before-input-event', { preventDefault: vi.fn() }, {
      type: 'keyDown',
      key: 'Escape',
    });

    expect(preferenceWindow.close).not.toHaveBeenCalled();
  });
});
