const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');

const noop = () => {};

class TestWebContents extends EventEmitter {
  constructor() {
    super();
    this.audioMuted = false;
    this.id = 0;
  }

  executeJavaScript() { return Promise.resolve(); }

  getURL() { return ''; }

  isDestroyed() { return false; }

  loadURL() { return Promise.resolve(); }

  openDevTools() {}

  send() {}
}

let currentWindow;

class BrowserWindow extends EventEmitter {
  static fromWebContents() { return currentWindow; }

  static getAllWindows() { return [currentWindow]; }

  constructor(options = {}) {
    super();
    this.options = options;
    this.webContents = new TestWebContents();
  }


  addChildView() {}

  addWebContentsView() {}

  close() {}


  getContentView() { return { addChildView: noop, removeChildView: noop }; }

  getSize() { return [720, 405]; }

  getWebContentsViews() { return []; }

  hide() {}

  isDestroyed() { return false; }

  isFocused() { return true; }

  isFullScreen() { return false; }

  isVisible() { return true; }

  loadURL() { return Promise.resolve(); }


  removeWebContentsView() {}


  setContentSize() {}

  setFullScreen() {}

  setMenu() {}

  setSize() {}

  setTouchBar() {}

  show() {}
}

class WebContentsView {
  constructor() { this.webContents = new TestWebContents(); }

  destroy() {}

  isDestroyed() { return false; }

  setAutoResize() {}

  setBounds() {}
}

class TestTouchBarItem {
  constructor(options = {}) { Object.assign(this, options); }
}

class TouchBar extends TestTouchBarItem {}
TouchBar.TouchBarButton = TestTouchBarItem;
TouchBar.TouchBarLabel = TestTouchBarItem;
TouchBar.TouchBarSpacer = TestTouchBarItem;

const app = Object.assign(new EventEmitter(), {
  addRecentDocument: noop,
  getAppPath: () => process.cwd(),
  getLocale: () => 'en',
  getName: () => 'SPlayer',
  getPath: name => (name === 'temp' ? os.tmpdir() : path.join(os.tmpdir(), 'splayer-test')),
  getVersion: () => '0.0.0-test',
  isPackaged: false,
  quit: noop,
  relaunch: noop,
  utils: {},
});

class TestIpc extends EventEmitter {
  invoke() { return Promise.resolve(); }

  send() {}

  sendSync() { return undefined; }
}

const ipcMain = new TestIpc();
const ipcRenderer = new TestIpc();
const dialog = {
  showErrorBox: noop,
  showMessageBox: () => Promise.resolve({ response: 0 }),
  showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
  showSaveDialog: () => Promise.resolve({ canceled: true }),
};
const shell = {
  openExternal: () => Promise.resolve(),
  openPath: () => Promise.resolve(''),
  showItemInFolder: noop,
};
const nativeImage = {
  createFromBuffer: buffer => ({
    toDataURL: () => `data:image/png;base64,${buffer.toString('base64')}`,
    toPNG: () => buffer,
  }),
  createFromPath: () => ({ resize() { return this; } }),
};
const nativeTheme = Object.assign(new EventEmitter(), {
  shouldUseDarkColors: false,
  themeSource: 'system',
});
class Menu {
  static applicationMenu = null;

  static buildFromTemplate() { return new Menu(); }

  static getApplicationMenu() { return Menu.applicationMenu; }

  static setApplicationMenu(menu) { Menu.applicationMenu = menu; }

  constructor() { this.items = []; }

  append(item) { this.items.push(item); }

  clear() { this.items = []; }

  getMenuItemById(id) {
    for (const item of this.items) {
      if (item.id === id) return item;
      if (item.submenu && typeof item.submenu.getMenuItemById === 'function') {
        const nestedItem = item.submenu.getMenuItemById(id);
        if (nestedItem) return nestedItem;
      }
    }
    return null;
  }

  popup() {}
}
class MenuItem { constructor(options = {}) { Object.assign(this, options); } }
class Notification { show() {} }
class Tray {}
const inAppPurchase = {};
const globalShortcut = { register: noop, unregisterAll: noop };
const screen = { getAllDisplays: () => [], getPrimaryDisplay: () => ({ workArea: {} }) };
const session = { defaultSession: {} };
const systemPreferences = {};
const webContents = { fromId: () => new TestWebContents() };

currentWindow = new BrowserWindow();
const remote = {
  app,
  BrowserWindow,
  dialog,
  getCurrentWebContents: () => currentWindow.webContents,
  getCurrentWindow: () => currentWindow,
  getGlobal: () => ({}),
  Menu,
  MenuItem,
  nativeImage,
  nativeTheme,
  shell,
  TouchBar,
  WebContentsView,
};

module.exports = {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  inAppPurchase,
  ipcMain,
  ipcRenderer,
  Menu,
  MenuItem,
  nativeImage,
  nativeTheme,
  Notification,
  remote,
  screen,
  session,
  shell,
  systemPreferences,
  TouchBar,
  Tray,
  webContents,
  WebContentsView,
};
