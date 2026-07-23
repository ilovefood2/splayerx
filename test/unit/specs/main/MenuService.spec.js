import { BrowserWindow, ipcMain } from 'electron';
import { vi } from 'vitest';
import MenuService from '@/../main/menu/MenuService';

describe('main MenuService window routing', () => {
  beforeEach(() => {
    ipcMain.removeAllListeners();
  });

  afterEach(() => {
    ipcMain.removeAllListeners();
    vi.restoreAllMocks();
  });

  it('ignores menu state updates sent by a background player window', () => {
    const focusedWindow = new BrowserWindow();
    const backgroundWindow = new BrowserWindow();
    const menuService = new MenuService();
    menuService.setMainWindow(focusedWindow);
    const updateMenuItemChecked = vi.spyOn(
      menuService.menu,
      'updateMenuItemChecked',
    );

    ipcMain.emit(
      'update-checked',
      { sender: backgroundWindow.webContents },
      'audio.mute',
      true,
    );
    expect(updateMenuItemChecked).not.toHaveBeenCalled();

    ipcMain.emit(
      'update-checked',
      { sender: focusedWindow.webContents },
      'audio.mute',
      true,
    );
    expect(updateMenuItemChecked).toHaveBeenCalledWith('audio.mute', true);
  });
});
