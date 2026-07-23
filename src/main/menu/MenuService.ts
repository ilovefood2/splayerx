import { app, ipcMain } from 'electron';
import { IBrowsingHistoryMenuInfo } from '@/interfaces/IBrowsingHistory';
import Menu from './Menu';
import { IMenuDisplayInfo } from '../../renderer/interfaces/IRecentPlay';
import { ISubtitleControlListItem } from '../../renderer/interfaces/ISubtitle';

export default class MenuService {
  private menu: Menu;

  private menuActionsRegistered = false;

  public constructor() {
    this.menu = new Menu();
  }

  public setMainWindow(window: Electron.BrowserWindow | null) {
    this.menu.setMainWindow(window);
    if (window) {
      if (!this.menuActionsRegistered) {
        this.registeMenuActions();
        this.menuActionsRegistered = true;
      }
    } else this.menu.closedMenu();
    setTimeout(() => app.emit('losslessStreaming-menu-update'), 50);
  }

  public focusMainWindow(window: Electron.BrowserWindow) {
    this.menu.focusMainWindow(window);
  }

  public enableMenu(enable: boolean) {
    this.menu.enableMenu(enable);
  }

  public updateMenuItemEnabled(id: string, enabled: boolean) {
    this.menu.updateMenuItemEnabled(id, enabled);
  }

  public updateFocusedWindow(isFocusedOnMain: boolean, isNewWindow: boolean) {
    this.menu.updateFocusedWindow(isFocusedOnMain, isNewWindow);
  }

  public updatePipIcon() {
    this.menu.updatePipIcon();
  }

  public updateAccount(user?: { displayName: string }) {
    this.menu.updateAccount(user);
  }

  private registeMenuActions() {
    ipcMain.on('popup-menu', (e) => {
      if (!this.menu.isEventFromMainWindow(e)) return;
      this.menu.popupMenu();
    });
    ipcMain.on('update-locale', (e) => {
      if (!this.menu.isEventFromMainWindow(e)) return;
      this.menu.updateLocale();
    });
    ipcMain.on('update-browisng-history', (e, items: IBrowsingHistoryMenuInfo[]) => {
      if (!this.menu.isEventFromMainWindow(e)) return;
      this.menu.updateBrowsingHistory(items);
    });
    ipcMain.on('update-recent-play', (e, items: IMenuDisplayInfo[]) => {
      if (!this.menu.isEventFromMainWindow(e)) return;
      this.menu.updateRecentPlay(items);
    });
    ipcMain.on('update-primary-sub', (e, items: { id: string, label: string, checked: boolean, subtitleItem: ISubtitleControlListItem }[]) => {
      if (!this.menu.isEventFromMainWindow(e)) return;
      this.menu.updatePrimarySub(items);
    });
    ipcMain.on('update-secondary-sub', (e, items: { id: string, label: string, checked: boolean, enabled: boolean, subtitleItem: ISubtitleControlListItem }[]) => {
      if (!this.menu.isEventFromMainWindow(e)) return;
      this.menu.updateSecondarySub(items);
    });
    ipcMain.on('update-audio-track', (e, items: { id: string, label: string }[]) => {
      if (!this.menu.isEventFromMainWindow(e)) return;
      this.menu.updateAudioTrack(items);
    });
    ipcMain.on('update-route-name', (e, routeName: string) => {
      if (!this.menu.isEventFromMainWindow(e)) return;
      this.menu.routeName = routeName;
    });
    ipcMain.on('update-label', (e, id: string, label: string) => {
      if (!this.menu.isEventFromMainWindow(e)) return;
      this.menu.updateMenuItemLabel(id, label);
    });
    ipcMain.on('update-checked', (e, id: string, checked: boolean) => {
      if (!this.menu.isEventFromMainWindow(e)) return;
      this.menu.updateMenuItemChecked(id, checked);
    });
    ipcMain.on('update-enabled', (e, id: string, enabled: boolean) => {
      if (!this.menu.isEventFromMainWindow(e)) return;
      this.menu.updateMenuItemEnabled(id, enabled);
    });
    ipcMain.on('update-focused-window', (e, isFocusedOnMain: boolean, isNewWindow: boolean) => {
      if (!this.menu.isEventFromMainWindow(e)) return;
      this.menu.updateFocusedWindow(isFocusedOnMain, isNewWindow);
    });
    ipcMain.on('update-professinal-menu', (e, isProfessinal: boolean) => {
      if (!this.menu.isEventFromMainWindow(e)) return;
      this.menu.updateMenuByProfessinal(isProfessinal);
    });
    ipcMain.on('update-professinal-reference', (e, sub?: ISubtitleControlListItem) => {
      if (!this.menu.isEventFromMainWindow(e)) return;
      this.menu.updateProfessinalReference(sub);
    });
    ipcMain.on('update-professinal-prev-menu-enable', (e, enabled: boolean) => {
      if (!this.menu.isEventFromMainWindow(e)) return;
      this.menu.updateAdvancedMenuPrev(enabled);
    });
    ipcMain.on('update-professinal-next-menu-enable', (e, enabled: boolean) => {
      if (!this.menu.isEventFromMainWindow(e)) return;
      this.menu.updateAdvancedMenuNext(enabled);
    });
    ipcMain.on('update-professinal-enter-menu-enable', (e, enabled: boolean) => {
      if (!this.menu.isEventFromMainWindow(e)) return;
      this.menu.updateAdvancedMenuEnter(enabled);
    });
    ipcMain.on('update-professinal-undo-menu-enable', (e, enabled: boolean) => {
      if (!this.menu.isEventFromMainWindow(e)) return;
      this.menu.updateAdvancedMenuUndo(enabled);
    });
    ipcMain.on('update-professinal-redo-menu-enable', (e, enabled: boolean) => {
      if (!this.menu.isEventFromMainWindow(e)) return;
      this.menu.updateAdvancedMenuRedo(enabled);
    });
  }
}
