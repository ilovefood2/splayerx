import 'fake-indexeddb/auto';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chai } from 'vitest';
import moduleAlias from 'module-alias';
import { config } from '@vue/test-utils';
import sinonChai from 'sinon-chai';
import electron, { remote } from 'electron';
import { rendererEventBus } from '../../src/renderer/services/globalEvents';

chai.use(sinonChai);
config.global.mocks.$bus = rendererEventBus;
config.global.mocks.$electron = electron;
config.global.mocks.$event = new EventEmitter();
config.global.directives['fade-in'] = {};

moduleAlias.addAlias(
  'electron',
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'mocks/electron.cjs'),
);
const electronMockUrl = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'mocks/electron.cjs'),
).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') {
      return { format: 'commonjs', shortCircuit: true, url: electronMockUrl };
    }
    return nextResolve(specifier, context);
  },
});
const { default: helpers } = await import('../../src/renderer/helpers');
config.global.mixins = [helpers];

window.remote = remote;
window.electron = electron;

Object.defineProperties(window.screen, {
  availHeight: { configurable: true, value: 900 },
  availLeft: { configurable: true, value: 0 },
  availTop: { configurable: true, value: 0 },
  availWidth: { configurable: true, value: 1440 },
});

if (!globalThis.ImageData) {
  globalThis.ImageData = class ImageData {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.data = new Uint8ClampedArray(width * height * 4);
    }
  };
}
globalThis.createImageBitmap = async source => source;

if (!HTMLMediaElement.prototype.play) {
  HTMLMediaElement.prototype.play = () => Promise.resolve();
}

if (!HTMLMediaElement.prototype.pause) {
  HTMLMediaElement.prototype.pause = () => {};
}

HTMLCanvasElement.prototype.getContext = () => ({
  clearRect() {},
  drawImage() {},
  fillRect() {},
  fillText() {},
  getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  lineTo() {},
  measureText: text => ({ width: text.length * 5.664827586 }),
  moveTo() {},
  putImageData() {},
  restore() {},
  save() {},
  setTransform() {},
  stroke() {},
});
HTMLCanvasElement.prototype.toDataURL = () => 'data:image/jpeg;base64,dGVzdA==';

const nativeGetComputedStyle = window.getComputedStyle.bind(window);
window.getComputedStyle = (element, pseudoElement) => {
  const style = nativeGetComputedStyle(element, pseudoElement);
  if (element instanceof HTMLSpanElement && element.textContent) {
    Object.defineProperties(style, {
      height: { configurable: true, value: '14.4px' },
      width: {
        configurable: true,
        value: `${element.textContent.length * 5.664827586}px`,
      },
    });
  }
  return style;
};
