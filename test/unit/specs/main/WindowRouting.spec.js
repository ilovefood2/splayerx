import { vi } from 'vitest';
import {
  isEventFromWindow,
  isUsableWindow,
  sendToWindows,
} from '@/../main/helpers/WindowRouting';

function createWindow({ destroyed = false, contentsDestroyed = false } = {}) {
  return {
    isDestroyed: () => destroyed,
    webContents: {
      isDestroyed: () => contentsDestroyed,
      send: vi.fn(),
    },
  };
}

describe('main window routing', () => {
  it('accepts IPC state updates only from the selected usable window', () => {
    const selectedWindow = createWindow();
    const backgroundWindow = createWindow();

    expect(isEventFromWindow(
      { sender: selectedWindow.webContents },
      selectedWindow,
    )).to.equal(true);
    expect(isEventFromWindow(
      { sender: backgroundWindow.webContents },
      selectedWindow,
    )).to.equal(false);
    expect(isEventFromWindow(
      { sender: selectedWindow.webContents },
      createWindow({ destroyed: true }),
    )).to.equal(false);
  });

  it('broadcasts shared state only to live player windows', () => {
    const firstWindow = createWindow();
    const secondWindow = createWindow();
    const closedWindow = createWindow({ contentsDestroyed: true });

    sendToWindows(
      new Set([firstWindow, secondWindow, closedWindow]),
      'mainDispatch',
      'setPreference',
      { isDarkMode: true },
    );

    expect(isUsableWindow(firstWindow)).to.equal(true);
    expect(firstWindow.webContents.send).toHaveBeenCalledWith(
      'mainDispatch',
      'setPreference',
      { isDarkMode: true },
    );
    expect(secondWindow.webContents.send).toHaveBeenCalledOnce();
    expect(closedWindow.webContents.send).not.toHaveBeenCalled();
  });
});
