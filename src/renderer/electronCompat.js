/*
 * Temporary compatibility surface for renderer code written against Electron
 * 13. Electron 14 removed `electron.remote`, and Electron 17 moved
 * desktopCapturer to the main process. @electron/remote provides the maintained
 * bridge while the rest of the app keeps its existing renderer API shape.
 */
const electron = require('electron'); // eslint-disable-line import/no-extraneous-dependencies
const remote = require('@electron/remote'); // eslint-disable-line import/no-extraneous-dependencies

if (!electron.remote) {
  Object.defineProperty(electron, 'remote', {
    configurable: true,
    enumerable: true,
    value: remote,
  });
}

if (!electron.desktopCapturer) {
  Object.defineProperty(electron, 'desktopCapturer', {
    configurable: true,
    enumerable: true,
    value: remote.getBuiltin('desktopCapturer'),
  });
}

// Some old renderer pages access `window.remote` directly.
window.remote = remote;
