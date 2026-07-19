/* eslint-disable */
const electron = require('electron');

const { ipcRenderer } = electron;
const callbacks = new Map();
let nextId = 1;

function sync(operation, request = {}) {
  return ipcRenderer.sendSync('splayer-renderer-bridge-sync', { operation, ...request });
}

function asyncCall(operation, request = {}) {
  return ipcRenderer.invoke('splayer-renderer-bridge-async', { operation, ...request });
}

function callbackId(callback) {
  const id = `renderer-${process.pid}-${nextId++}`;
  callbacks.set(id, callback);
  return id;
}

function revive(value) {
  if (!value || typeof value !== 'object') return value;
  if (value.__event) return { preventDefault() {} };
  if (value.__splayerNativeImage) {
    const png = Buffer.from(value.png);
    return electron.nativeImage ? electron.nativeImage.createFromBuffer(png) : {
      toPNG: () => png,
      toDataURL: () => `data:image/png;base64,${png.toString('base64')}`,
    };
  }
  if (Array.isArray(value)) return value.map(revive);
  const result = {};
  Object.keys(value).forEach((key) => { result[key] = revive(value[key]); });
  return result;
}

ipcRenderer.on('splayer-renderer-bridge-event', (event, id, args = []) => {
  const callback = callbacks.get(id);
  if (callback) callback(...args.map(revive));
});

function createEmitter(target) {
  const listenerIds = new Map();
  const keyFor = (eventName, listener) => {
    if (!listenerIds.has(eventName)) listenerIds.set(eventName, new Map());
    const listeners = listenerIds.get(eventName);
    if (!listeners.has(listener)) listeners.set(listener, callbackId(listener));
    return listeners.get(listener);
  };
  return {
    addListener(eventName, listener) {
      sync('subscribe', {
        eventName, subscriptionId: keyFor(eventName, listener), target,
      });
      return this;
    },
    on(eventName, listener) { return this.addListener(eventName, listener); },
    once(eventName, listener) {
      const id = keyFor(eventName, listener);
      sync('subscribe', {
        eventName, once: true, subscriptionId: id, target,
      });
      return this;
    },
    removeListener(eventName, listener) {
      const listeners = listenerIds.get(eventName);
      const id = listeners && listeners.get(listener);
      if (id) {
        sync('unsubscribe', { subscriptionId: id });
        callbacks.delete(id);
        listeners.delete(listener);
      }
      return this;
    },
    removeAllListeners(eventName) {
      const names = eventName ? [eventName] : [...listenerIds.keys()];
      names.forEach((name) => {
        const listeners = listenerIds.get(name);
        if (!listeners) return;
        listeners.forEach((id) => {
          sync('unsubscribe', { subscriptionId: id });
          callbacks.delete(id);
        });
        listenerIds.delete(name);
      });
      return this;
    },
  };
}

function createWebContents(target) {
  const emitter = createEmitter({ type: 'contents', selector: target });
  const call = method => (...args) => sync('contents:call', { args, method, target });
  const asyncMethod = method => (...args) => asyncCall('contents:call', { args, method, target });
  const contents = {
    ...emitter,
    canGoBack: call('canGoBack'),
    canGoForward: call('canGoForward'),
    copy: call('copy'),
    cut: call('cut'),
    executeJavaScript: asyncMethod('executeJavaScript'),
    focus: call('focus'),
    getTitle: call('getTitle'),
    getURL: call('getURL'),
    goBack: call('goBack'),
    goForward: call('goForward'),
    insertCSS: asyncMethod('insertCSS'),
    isDestroyed: call('isDestroyed'),
    isFocused: call('isFocused'),
    isLoading: call('isLoading'),
    loadURL: asyncMethod('loadURL'),
    openDevTools: call('openDevTools'),
    paste: call('paste'),
    redo: call('redo'),
    reload: call('reload'),
    selectAll: call('selectAll'),
    sendInputEvent: call('sendInputEvent'),
    stop: call('stop'),
    undo: call('undo'),
  };
  Object.defineProperty(contents, 'audioMuted', {
    set(value) { sync('contents:set', { property: 'audioMuted', target, value }); },
  });
  return contents;
}

function createView(id) {
  const call = method => (...args) => sync('view:call', { args, id, method });
  return {
    __splayerViewId: id,
    destroy: call('destroy'),
    isDestroyed: call('isDestroyed'),
    setBackgroundColor: call('setBackgroundColor'),
    setBounds: call('setBounds'),
    webContents: createWebContents({ viewId: id }),
  };
}

function createWindow(selector = {}) {
  const call = method => (...args) => sync('window:call', { args, method, selector });
  const window = {
    ...createEmitter({ type: 'window', selector }),
    blur: call('blur'),
    center: call('center'),
    close: call('close'),
    focus: call('focus'),
    getBounds: call('getBounds'),
    getContentBounds: call('getContentBounds'),
    getMinimumSize: call('getMinimumSize'),
    getPosition: call('getPosition'),
    getSize: call('getSize'),
    getWebContentsViews: () => (sync('window:call', {
      args: [], method: 'getWebContentsViews', selector,
    }) || []).map(createView),
    hide: call('hide'),
    id: sync('window:id', { selector }),
    isDestroyed: call('isDestroyed'),
    isFocused: call('isFocused'),
    isFullScreen: call('isFullScreen'),
    isMaximizable: call('isMaximizable'),
    isMaximized: call('isMaximized'),
    isMinimized: call('isMinimized'),
    isResizable: call('isResizable'),
    isVisible: call('isVisible'),
    maximize: call('maximize'),
    minimize: call('minimize'),
    restore: call('restore'),
    setAlwaysOnTop: call('setAlwaysOnTop'),
    setBounds: call('setBounds'),
    setFullScreen: call('setFullScreen'),
    setMaximizable: call('setMaximizable'),
    setMinimumSize: call('setMinimumSize'),
    setPosition: call('setPosition'),
    setResizable: call('setResizable'),
    setSize: call('setSize'),
    setTouchBar: touchBar => sync('window:call', {
      args: [touchBar && touchBar.toDescriptor ? touchBar.toDescriptor() : null],
      method: 'setTouchBar', selector,
    }),
    show: call('show'),
    unmaximize: call('unmaximize'),
  };
  window.webContents = createWebContents({ window: selector });
  Object.defineProperty(window, 'resizable', {
    get() { return sync('window:get', { property: 'resizable', selector }); },
    set(value) { sync('window:set', { property: 'resizable', selector, value }); },
  });
  return window;
}

let nextTouchBarItemId = 1;
class TouchBarItem {
  constructor(type, options = {}) {
    this.id = `touchbar-item-${nextTouchBarItemId++}`;
    this.type = type;
    this.options = { ...options };
    if (options.click) this.actionId = callbackId(options.click);
  }

  descriptor() {
    const { click, ...serializableOptions } = this.options;
    return {
      ...serializableOptions,
      actionId: this.actionId,
      id: this.id,
      type: this.type,
    };
  }
}

class TouchBarButton extends TouchBarItem {
  constructor(options) { super('button', options); }
}
class TouchBarLabel extends TouchBarItem {
  constructor(options) { super('label', options); }
}
class TouchBarSpacer extends TouchBarItem {
  constructor(options) { super('spacer', options); }
}

['icon', 'label'].forEach((property) => {
  Object.defineProperty(TouchBarItem.prototype, property, {
    get() { return this.options[property]; },
    set(value) {
      this.options[property] = value;
      sync('touchbar:update', {
        id: this.id, property, selector: {}, value,
      });
    },
  });
});

class RendererTouchBar {
  constructor(options = {}) { this.items = options.items || []; }
  toDescriptor() { return { items: this.items.map(item => item.descriptor()) }; }
}
RendererTouchBar.TouchBarButton = TouchBarButton;
RendererTouchBar.TouchBarLabel = TouchBarLabel;
RendererTouchBar.TouchBarSpacer = TouchBarSpacer;

class RendererMenuItem {
  constructor(options = {}) {
    this.options = { ...options };
    this.checked = Boolean(options.checked);
  }
}

class RendererMenu {
  constructor() { this.items = []; }
  append(item) { this.items.push(item); }
  getMenuItemById(id) { return { checked: sync('menu:checked', { id }) }; }
  popup() {
    const items = this.items.map(({ options }) => ({
      actionId: options.click ? callbackId(options.click) : undefined,
      enabled: options.enabled,
      label: options.label,
      type: options.type,
    }));
    return asyncCall('menu:popup', { items });
  }
  static getApplicationMenu() { return new RendererMenu(); }
}

class RendererWebContentsView {
  constructor(options = {}) {
    return createView(sync('view:create', { webPreferences: options.webPreferences }));
  }
}

const appBridge = {
  addRecentDocument: path => sync('app:call', { args: [path], method: 'addRecentDocument' }),
  applePay(product, id, currency, quantity, callback) {
    const actionId = callbackId(callback || (() => {}));
    return asyncCall('app:applePay', { actionId, args: [product, id, currency, quantity] });
  },
  clearRecentDocuments: () => sync('app:call', { method: 'clearRecentDocuments' }),
  crossThreadCache: (key, operation) => operation(),
  emit: (eventName, ...args) => sync('app:emit', { args, eventName }),
  getAppPath: () => sync('app:call', { method: 'getAppPath' }),
  getDisplayLanguage: () => sync('app:call', { method: 'getDisplayLanguage' }),
  getIP: () => sync('app:call', { method: 'getIP' }),
  getLocale: () => sync('app:call', { method: 'getLocale' }),
  getName: () => sync('app:call', { method: 'getName' }),
  getPath: name => sync('app:call', { args: [name], method: 'getPath' }),
  getVersion: () => sync('app:call', { method: 'getVersion' }),
  hide: () => sync('app:call', { method: 'hide' }),
  quit: () => sync('app:call', { method: 'quit' }),
  utils: {},
};
Object.defineProperties(appBridge, {
  isPackaged: { get: () => sync('app:get', { property: 'isPackaged' }) },
  name: { get: () => sync('app:get', { property: 'name' }) },
});

const themeEmitter = createEmitter({ type: 'nativeTheme' });
const themeBridge = {
  ...themeEmitter,
};
Object.defineProperties(themeBridge, {
  shouldUseDarkColors: { get: () => sync('theme:get', { property: 'shouldUseDarkColors' }) },
  themeSource: {
    get: () => sync('theme:get', { property: 'themeSource' }),
    set: value => sync('theme:set', { property: 'themeSource', value }),
  },
});

const nativeImageBridge = {
  createFromPath(imagePath) {
    const descriptor = {
      __splayerImagePath: imagePath,
    };
    Object.defineProperty(descriptor, 'resize', {
      enumerable: false,
      value(size) {
        descriptor.resizeOptions = size;
        return descriptor;
      },
    });
    return descriptor;
  },
};

const bridge = {
  app: appBridge,
  BrowserWindow: {
    getAllWindows: () => (sync('window:list') || []).map(id => createWindow({ id })),
    getFocusedWindow: () => createWindow({ focused: true }),
  },
  dialog: {
    showMessageBox: (...args) => asyncCall('dialog:message', { args: [args[args.length - 1]] }),
    showOpenDialog: (...args) => asyncCall('dialog:open', { args: [args[args.length - 1]] }),
  },
  getCurrentWebContents: () => createWebContents({ window: {} }),
  getCurrentWindow: () => createWindow({}),
  getGlobal: name => sync('global:get', { name }),
  Menu: RendererMenu,
  MenuItem: RendererMenuItem,
  nativeImage: nativeImageBridge,
  nativeTheme: themeBridge,
  screen: {
    getCursorScreenPoint: () => sync('screen:call', { method: 'getCursorScreenPoint' }),
    getDisplayNearestPoint: point => sync('screen:call', {
      args: [point], method: 'getDisplayNearestPoint',
    }),
  },
  shell: { openExternal: url => asyncCall('shell:openExternal', { args: [url] }) },
  TouchBar: RendererTouchBar,
  WebContentsView: RendererWebContentsView,
};

bridge.desktopCapturer = {
  async getSources(options) {
    const sources = await asyncCall('desktopCapturer:getSources', { args: [options] });
    return sources.map(source => ({
      ...source,
      appIcon: source.appIcon && revive({ __splayerNativeImage: true, png: source.appIcon }),
      thumbnail: revive({ __splayerNativeImage: true, png: source.thumbnail }),
    }));
  },
};

module.exports = bridge;
