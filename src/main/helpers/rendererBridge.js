/* eslint-disable complexity, max-len, no-underscore-dangle */
import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  MenuItem,
  nativeImage,
  nativeTheme,
  screen,
  shell,
  TouchBar,
  WebContentsView,
} from 'electron';

const views = new Map();
const subscriptions = new Map();
const windowTouchBars = new Map();

const WINDOW_READ_METHODS = new Set([
  'getBounds', 'getContentBounds', 'getMinimumSize', 'getPosition', 'getSize',
  'isDestroyed', 'isFocused', 'isFullScreen', 'isMaximizable', 'isMaximized',
  'isMinimized', 'isResizable', 'isVisible',
]);
const WINDOW_WRITE_METHODS = new Set([
  'blur', 'center', 'close', 'focus', 'hide', 'maximize', 'minimize', 'restore',
  'setAlwaysOnTop', 'setBounds', 'setFullScreen', 'setMaximizable', 'setMinimumSize',
  'setPosition', 'setResizable', 'setSize', 'show', 'unmaximize',
]);
const CONTENTS_READ_METHODS = new Set([
  'canGoBack', 'canGoForward', 'getTitle', 'getURL', 'isDestroyed', 'isFocused',
  'isLoading',
]);
const CONTENTS_WRITE_METHODS = new Set([
  'copy', 'cut', 'focus', 'goBack', 'goForward', 'openDevTools', 'paste', 'redo',
  'reload', 'selectAll', 'sendInputEvent', 'setAudioMuted', 'stop', 'undo',
]);
const CONTENTS_ASYNC_METHODS = new Set([
  'executeJavaScript', 'insertCSS', 'loadURL',
]);
const APP_METHODS = new Set([
  'addRecentDocument', 'clearRecentDocuments', 'getAppPath', 'getDisplayLanguage',
  'getIP', 'getLocale', 'getName', 'getPath', 'getVersion', 'hide', 'quit',
]);
const APP_EVENTS = new Set([
  'add-window-losslessStreaming', 'cast-request', 'losslessStreaming-select',
  'losslessStreaming-stop', 'refresh-token', 'sign-out',
]);

function getSenderWindow(event) {
  return BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow();
}

function getWindow(event, selector = {}) {
  if (selector.id) return BrowserWindow.fromId(selector.id);
  if (selector.focused) return BrowserWindow.getFocusedWindow() || getSenderWindow(event);
  return getSenderWindow(event);
}

function registerView(view) {
  if (view && view.webContents) views.set(view.webContents.id, view);
  return view;
}

function getView(event, id) {
  if (views.has(id)) return views.get(id);
  for (const window of BrowserWindow.getAllWindows()) {
    const view = window.getWebContentsViews().find(item => item.webContents.id === id);
    if (view) return registerView(view);
  }
  const senderWindow = getSenderWindow(event);
  return senderWindow && senderWindow.getWebContentsViews()
    .map(registerView).find(item => item.webContents.id === id);
}

function getContents(event, target = {}) {
  if (target.viewId) {
    const view = getView(event, target.viewId);
    return view && view.webContents;
  }
  const window = getWindow(event, target.window || target);
  return window && window.webContents;
}

function imageFromDescriptor(value) {
  if (!value || typeof value !== 'object' || !value.__splayerImagePath) return value;
  let image = nativeImage.createFromPath(value.__splayerImagePath);
  if (value.resizeOptions) image = image.resize(value.resizeOptions);
  return image;
}

function serializeEventArg(value) {
  if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return value.map(serializeEventArg);
  if (typeof value === 'object') {
    if (typeof value.toPNG === 'function' && typeof value.toDataURL === 'function') {
      return { __splayerNativeImage: true, png: value.toPNG() };
    }
    const result = {};
    Object.keys(value).forEach((key) => {
      if (typeof value[key] !== 'function') result[key] = serializeEventArg(value[key]);
    });
    return result;
  }
  return undefined;
}

function sendSubscription(event, subscriptionId, args) {
  if (!event.sender.isDestroyed()) {
    event.sender.send('splayer-renderer-bridge-event', subscriptionId,
      args.map(serializeEventArg));
  }
}

function subscribe(event, subscriptionId, target, eventName, once) {
  let emitter;
  if (target.type === 'window') emitter = getWindow(event, target.selector);
  if (target.type === 'contents') emitter = getContents(event, target.selector);
  if (target.type === 'view') {
    const view = getView(event, target.id);
    emitter = view && view.webContents;
  }
  if (target.type === 'nativeTheme') emitter = nativeTheme;
  if (!emitter || typeof emitter.on !== 'function') return false;
  const listener = (...args) => {
    // Electron event objects cannot cross structured clone. Renderer listeners only
    // need preventDefault plus the serializable arguments that follow it.
    if (args[0] && typeof args[0].preventDefault === 'function') args[0] = { __event: true };
    sendSubscription(event, subscriptionId, args);
    if (once) subscriptions.delete(subscriptionId);
  };
  subscriptions.set(subscriptionId, { emitter, eventName, listener });
  emitter[once ? 'once' : 'on'](eventName, listener);
  return true;
}

function unsubscribe(subscriptionId) {
  const subscription = subscriptions.get(subscriptionId);
  if (!subscription) return;
  subscription.emitter.removeListener(subscription.eventName, subscription.listener);
  subscriptions.delete(subscriptionId);
}

function makeTouchBar(event, descriptor) {
  if (!descriptor || !Array.isArray(descriptor.items)) return null;
  const items = descriptor.items.map((item) => {
    if (item.type === 'spacer') return new TouchBar.TouchBarSpacer({ size: item.size });
    if (item.type === 'label') {
      const label = new TouchBar.TouchBarLabel({ label: item.label || '' });
      label.__splayerId = item.id;
      return label;
    }
    const button = new TouchBar.TouchBarButton({
      backgroundColor: item.backgroundColor,
      icon: imageFromDescriptor(item.icon),
      iconPosition: item.iconPosition,
      label: item.label,
      click: item.actionId ? () => sendSubscription(event, item.actionId, []) : undefined,
    });
    button.__splayerId = item.id;
    return button;
  });
  const touchBar = new TouchBar({ items });
  touchBar.__splayerItems = items;
  return touchBar;
}

function registerRendererBridge() {
  ipcMain.on('splayer-renderer-bridge-sync', (event, request = {}) => {
    try {
      const { args = [], operation } = request;
      if (operation === 'app:get') {
        if (request.property === 'name') event.returnValue = app.name;
        else if (request.property === 'isPackaged') event.returnValue = app.isPackaged;
        else event.returnValue = undefined;
        return;
      }
      if (operation === 'app:call') {
        if (!APP_METHODS.has(request.method) || typeof app[request.method] !== 'function') throw new Error('Unsupported app method');
        event.returnValue = app[request.method](...args);
        return;
      }
      if (operation === 'app:emit') {
        if (!APP_EVENTS.has(request.eventName)) throw new Error('Unsupported app event');
        event.returnValue = app.emit(request.eventName, ...args);
        return;
      }
      if (operation === 'global:get') {
        event.returnValue = request.name === 'account' ? global.account : undefined;
        return;
      }
      if (operation === 'window:list') {
        event.returnValue = BrowserWindow.getAllWindows().map(window => window.id);
        return;
      }
      if (operation === 'window:id') {
        const window = getWindow(event, request.selector);
        event.returnValue = window ? window.id : null;
        return;
      }
      if (operation === 'window:call') {
        const window = getWindow(event, request.selector);
        if (!window) { event.returnValue = undefined; return; }
        if (request.method === 'getWebContentsViews') {
          event.returnValue = window.getWebContentsViews().map(view => registerView(view).webContents.id);
          return;
        }
        if (request.method === 'setTouchBar') {
          const touchBar = makeTouchBar(event, args[0]);
          windowTouchBars.set(window.id, touchBar);
          window.setTouchBar(touchBar);
          event.returnValue = true;
          return;
        }
        if (!WINDOW_READ_METHODS.has(request.method) && !WINDOW_WRITE_METHODS.has(request.method)) throw new Error('Unsupported window method');
        event.returnValue = window[request.method](...args);
        return;
      }
      if (operation === 'window:get') {
        const window = getWindow(event, request.selector);
        event.returnValue = request.property === 'resizable' ? window.isResizable() : undefined;
        return;
      }
      if (operation === 'window:set') {
        const window = getWindow(event, request.selector);
        if (request.property === 'resizable') window.setResizable(Boolean(request.value));
        event.returnValue = true;
        return;
      }
      if (operation === 'view:create') {
        const view = registerView(new WebContentsView({ webPreferences: request.webPreferences || {} }));
        event.returnValue = view.webContents.id;
        return;
      }
      if (operation === 'view:call') {
        const view = getView(event, request.id);
        if (!view) { event.returnValue = undefined; return; }
        if (!['destroy', 'isDestroyed', 'setBounds', 'setBackgroundColor'].includes(request.method)) throw new Error('Unsupported view method');
        event.returnValue = view[request.method](...args);
        if (request.method === 'destroy') views.delete(request.id);
        return;
      }
      if (operation === 'contents:call') {
        const contents = getContents(event, request.target);
        if (!contents) { event.returnValue = undefined; return; }
        if (!CONTENTS_READ_METHODS.has(request.method) && !CONTENTS_WRITE_METHODS.has(request.method)) throw new Error('Unsupported webContents method');
        event.returnValue = contents[request.method](...args);
        return;
      }
      if (operation === 'contents:set') {
        const contents = getContents(event, request.target);
        if (request.property === 'audioMuted') contents.setAudioMuted(Boolean(request.value));
        event.returnValue = true;
        return;
      }
      if (operation === 'screen:call') {
        if (!['getCursorScreenPoint', 'getDisplayNearestPoint'].includes(request.method)) throw new Error('Unsupported screen method');
        event.returnValue = screen[request.method](...args);
        return;
      }
      if (operation === 'theme:get') {
        event.returnValue = nativeTheme[request.property];
        return;
      }
      if (operation === 'theme:set') {
        if (request.property !== 'themeSource') throw new Error('Unsupported nativeTheme property');
        nativeTheme.themeSource = request.value;
        event.returnValue = true;
        return;
      }
      if (operation === 'menu:checked') {
        const item = Menu.getApplicationMenu() && Menu.getApplicationMenu().getMenuItemById(request.id);
        event.returnValue = item ? item.checked : false;
        return;
      }
      if (operation === 'subscribe') {
        event.returnValue = subscribe(event, request.subscriptionId, request.target, request.eventName, request.once);
        return;
      }
      if (operation === 'unsubscribe') {
        unsubscribe(request.subscriptionId);
        event.returnValue = true;
        return;
      }
      if (operation === 'touchbar:update') {
        const window = getWindow(event, request.selector);
        const touchBar = window && windowTouchBars.get(window.id);
        const item = touchBar && touchBar.__splayerItems
          && touchBar.__splayerItems.find(candidate => candidate.__splayerId === request.id);
        if (item && ['icon', 'label'].includes(request.property)) {
          item[request.property] = request.property === 'icon'
            ? imageFromDescriptor(request.value) : request.value;
        }
        event.returnValue = Boolean(item);
        return;
      }
      event.returnValue = undefined;
    } catch (error) {
      console.error('renderer bridge sync error', request.operation, error);
      event.returnValue = undefined;
    }
  });

  ipcMain.handle('splayer-renderer-bridge-async', async (event, request = {}) => {
    const { args = [], operation } = request;
    if (operation === 'contents:call') {
      if (!CONTENTS_ASYNC_METHODS.has(request.method)) throw new Error('Unsupported async webContents method');
      const contents = getContents(event, request.target);
      return contents && contents[request.method](...args);
    }
    if (operation === 'dialog:open') return dialog.showOpenDialog(getSenderWindow(event), args[0] || {});
    if (operation === 'dialog:message') return dialog.showMessageBox(getSenderWindow(event), args[0] || {});
    if (operation === 'shell:openExternal') return shell.openExternal(args[0]);
    if (operation === 'desktopCapturer:getSources') {
      const sources = await desktopCapturer.getSources(args[0]);
      return sources.map(source => ({
        appIcon: source.appIcon ? source.appIcon.toPNG() : null,
        display_id: source.display_id,
        id: source.id,
        name: source.name,
        thumbnail: source.thumbnail.toPNG(),
      }));
    }
    if (operation === 'menu:popup') {
      const actionIds = [];
      const menu = new Menu();
      (request.items || []).forEach((item) => {
        actionIds.push(item.actionId);
        menu.append(new MenuItem({
          enabled: item.enabled !== false,
          label: item.label,
          type: item.type,
          click: item.actionId ? () => sendSubscription(event, item.actionId, []) : undefined,
        }));
      });
      menu.popup({ window: getSenderWindow(event) });
      return actionIds.length;
    }
    if (operation === 'app:applePay') {
      if (typeof app.applePay !== 'function') return false;
      const [product, id, currency, quantity] = args;
      app.applePay(product, id, currency, quantity,
        result => sendSubscription(event, request.actionId, [result]));
      return true;
    }
    throw new Error(`Unsupported renderer bridge operation: ${operation}`);
  });

  app.on('web-contents-created', (createdEvent, contents) => {
    contents.once('destroyed', () => {
      views.delete(contents.id);
      [...subscriptions.entries()].forEach(([id, subscription]) => {
        if (subscription.emitter === contents) subscriptions.delete(id);
      });
    });
  });
}

registerRendererBridge();

export default registerRendererBridge;
