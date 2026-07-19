import { ipcRenderer, remote } from 'electron';
import { vi } from 'vitest';
import drag from '@/helpers/drag';

describe('drag helper', () => {
  let cleanup;
  let element;

  beforeEach(() => {
    element = document.createElement('div');
    document.body.appendChild(element);
    remote.getCurrentWindow().getPosition = vi.fn(() => [100, 200]);
    vi.spyOn(ipcRenderer, 'send');
  });

  afterEach(() => {
    if (cleanup) cleanup();
    cleanup = null;
    element.remove();
    vi.restoreAllMocks();
  });

  it('moves a macOS window without making the surface a native drag region', () => {
    cleanup = drag(element, 'darwin');
    element.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      button: 0,
      screenX: 120,
      screenY: 230,
    }));
    window.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      buttons: 1,
      screenX: 150,
      screenY: 270,
    }));

    expect(ipcRenderer.send).toHaveBeenCalledWith(
      'setFocusedWindowPosition',
      [130, 240],
    );
  });

  it('does not move the window from an interactive no-drag control', () => {
    const button = document.createElement('button');
    button.className = 'no-drag';
    element.appendChild(button);
    cleanup = drag(element, 'darwin');

    button.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      button: 0,
      screenX: 120,
      screenY: 230,
    }));
    window.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      buttons: 1,
      screenX: 150,
      screenY: 270,
    }));

    expect(ipcRenderer.send).not.toHaveBeenCalled();
  });
});
