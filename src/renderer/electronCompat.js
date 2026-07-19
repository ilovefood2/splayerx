/*
 * Renderer-facing Electron APIs are deliberately limited and transported over
 * whitelisted IPC handlers in the main process. This keeps legacy call sites
 * working without exposing main-process objects through a remote-object module.
 */
const electron = require('electron'); // eslint-disable-line import/no-extraneous-dependencies
const rendererBridge = require('../../static/rendererBridge');
const { installIpcSerialization } = require('./ipcSerialization');

installIpcSerialization(electron.ipcRenderer);

if (!electron.remote) {
  Object.defineProperty(electron, 'remote', {
    configurable: true,
    enumerable: true,
    value: rendererBridge,
  });
}

if (!electron.desktopCapturer) {
  Object.defineProperty(electron, 'desktopCapturer', {
    configurable: true,
    enumerable: true,
    value: rendererBridge.desktopCapturer,
  });
}

// Some embedded renderer pages still use this global API shape. It is the same
// restricted IPC bridge, not Electron's removed remote module.
window.remote = rendererBridge;
