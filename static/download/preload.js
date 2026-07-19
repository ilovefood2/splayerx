/* eslint-disable @typescript-eslint/no-var-requires */
// eslint-disable-next-line no-console
const { ipcRenderer } = require('electron');
const remote = require('@electron/remote');

window.isDarwin = process.platform === 'darwin';

window.ipcRenderer = ipcRenderer;

window.remote = remote;

window.displayLanguage = remote.app.getDisplayLanguage();
