import { BrowserWindow, ipcMain, Menu } from 'electron';
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

  it('exposes permanent playing-video deletion with the Mac shortcut', () => {
    const focusedWindow = new BrowserWindow();
    const send = vi.spyOn(focusedWindow.webContents, 'send');
    const menuService = new MenuService();
    menuService.setMainWindow(focusedWindow);
    menuService.menu.routeName = 'playing-view';

    const item = Menu.getApplicationMenu().getMenuItemById('file.deleteCurrent');
    expect(item.accelerator).toBe('Command+Backspace');
    expect(item.enabled).toBe(false);

    menuService.updateMenuItemEnabled('file.deleteCurrent', true);
    item.click();
    expect(send).toHaveBeenCalledWith('file.deleteCurrent');
  });

  it('maps Command+Right to next and Command+Left to previous video', () => {
    const focusedWindow = new BrowserWindow();
    const send = vi.spyOn(focusedWindow.webContents, 'send');
    const menuService = new MenuService();
    menuService.setMainWindow(focusedWindow);
    menuService.menu.routeName = 'playing-view';

    const next = Menu.getApplicationMenu().getMenuItemById('playback.nextVideo');
    const previous = Menu.getApplicationMenu().getMenuItemById('playback.previousVideo');
    expect(next.accelerator).toBe('Command+Right');
    expect(previous.accelerator).toBe('Command+Left');

    next.click();
    previous.click();
    expect(send).toHaveBeenNthCalledWith(1, 'playback.nextVideo');
    expect(send).toHaveBeenNthCalledWith(2, 'playback.previousVideo');
  });
});
