/* eslint-disable @typescript-eslint/no-var-requires */
// eslint-disable-next-line no-console
const { ipcRenderer, clipboard } = require('electron');
const remote = require('@electron/remote');

window.isDarwin = process.platform === 'darwin';

window.isMAS = process.mas;

window.ipcRenderer = ipcRenderer;

window.remote = remote;

window.displayLanguage = remote.app.getDisplayLanguage();

window.clipboard = clipboard;
