import path from 'path';
import os from 'os';
import electron from 'electron';

const noop = () => {};
class TestTouchBarItem {
  constructor(options = {}) {
    Object.assign(this, options);
  }
}
class TestTouchBar extends TestTouchBarItem {}
TestTouchBar.TouchBarButton = TestTouchBarItem;
TestTouchBar.TouchBarLabel = TestTouchBarItem;
TestTouchBar.TouchBarSpacer = TestTouchBarItem;

const testApp = {
  isPackaged: false,
  utils: {},
  addRecentDocument: noop,
  emit: noop,
  getAppPath: () => process.cwd(),
  getLocale: () => 'en',
  getName: () => 'SPlayer',
  getPath: name => (name === 'temp' ? os.tmpdir() : path.join(os.tmpdir(), 'splayer-test')),
  getVersion: () => '0.0.0-test',
  on: noop,
  once: noop,
};
const testWindow = {
  getSize: () => [720, 405],
  isFocused: () => true,
  isVisible: () => true,
  setTouchBar: noop,
  webContents: {
    id: 0,
    once: noop,
  },
};
const testRemote = {
  app: testApp,
  BrowserWindow: electron.BrowserWindow,
  dialog: electron.dialog,
  getCurrentWebContents: () => ({ audioMuted: false }),
  getCurrentWindow: () => testWindow,
  getGlobal: () => ({}),
  Menu: electron.Menu,
  MenuItem: electron.MenuItem,
  nativeImage: {
    createFromPath: () => ({
      resize() { return this; },
    }),
  },
  nativeTheme: {
    on: noop,
    shouldUseDarkColors: false,
    themeSource: 'system',
  },
  shell: electron.shell,
  TouchBar: TestTouchBar,
};

Object.defineProperty(electron, 'remote', {
  configurable: true,
  enumerable: true,
  value: testRemote,
});
window.remote = testRemote;
