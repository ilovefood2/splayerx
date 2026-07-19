import { EventEmitter } from 'events';
import { Menu } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import {
  getPreferenceEditAction,
  isPreferenceCloseShortcut,
  preferenceEditMenuTemplate,
  registerPreferenceWindowControls,
} from '../../../../src/main/helpers/preferenceWindowControls';

function createPreferenceWindow() {
  const webContents = new EventEmitter();
  ['copy', 'cut', 'paste', 'redo', 'selectAll', 'undo'].forEach((action) => {
    webContents[action] = vi.fn();
  });
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

  it('maps native editing shortcuts on macOS and Windows', () => {
    expect(getPreferenceEditAction({ type: 'keyDown', key: 'v', meta: true }, 'darwin')).toBe('paste');
    expect(getPreferenceEditAction({ type: 'keyDown', key: 'a', control: true }, 'win32')).toBe('selectAll');
    expect(getPreferenceEditAction({ type: 'keyDown', key: 'z', meta: true, shift: true }, 'darwin')).toBe('redo');
    expect(getPreferenceEditAction({ type: 'keyDown', key: 'v' }, 'darwin')).toBeNull();
  });

  it('routes paste to the focused preference web contents', () => {
    const preferenceWindow = createPreferenceWindow();
    const event = { preventDefault: vi.fn() };
    registerPreferenceWindowControls(preferenceWindow, 'darwin');

    preferenceWindow.webContents.emit('before-input-event', event, {
      type: 'keyDown',
      key: 'v',
      meta: true,
    });

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(preferenceWindow.webContents.paste).toHaveBeenCalledOnce();
    expect(preferenceWindow.close).not.toHaveBeenCalled();
  });

  it('provides a native editing context menu for text inputs', () => {
    const preferenceWindow = createPreferenceWindow();
    const event = { preventDefault: vi.fn() };
    const popup = vi.fn();
    const buildMenu = vi.spyOn(Menu, 'buildFromTemplate').mockReturnValue({ popup });
    registerPreferenceWindowControls(preferenceWindow, 'darwin');

    preferenceWindow.webContents.emit('context-menu', event, { isEditable: true });

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(buildMenu).toHaveBeenCalledWith(preferenceEditMenuTemplate({ isEditable: true }));
    expect(popup).toHaveBeenCalledWith({ window: preferenceWindow });
    buildMenu.mockRestore();
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
