import { createRequire } from 'node:module';
import sinon from 'sinon';

const require = createRequire(import.meta.url);
const { ipcRenderer } = require('../mocks/electron.cjs');
const bridge = require('../../../static/rendererBridge');

describe('renderer IPC bridge', () => {
  beforeEach(() => {
    sinon.stub(ipcRenderer, 'sendSync').callsFake((channel, request) => {
      expect(channel).to.equal('splayer-renderer-bridge-sync');
      if (request.operation === 'app:call' && request.method === 'getVersion') return '9.9.9';
      if (request.operation === 'window:id') return 7;
      if (request.operation === 'window:call' && request.method === 'getSize') return [800, 450];
      if (request.operation === 'window:call' && request.method === 'getWebContentsViews') return [42];
      if (request.operation === 'view:create') return 84;
      return true;
    });
    sinon.stub(ipcRenderer, 'invoke').resolves({ canceled: true, filePaths: [] });
  });

  afterEach(() => sinon.restore());

  it('routes application and window reads through the whitelisted IPC channel', () => {
    expect(bridge.app.getVersion()).to.equal('9.9.9');
    expect(bridge.getCurrentWindow().getSize()).to.deep.equal([800, 450]);
  });

  it('wraps WebContentsViews without exposing a main-process object', () => {
    const [view] = bridge.getCurrentWindow().getWebContentsViews();
    expect(view.__splayerViewId).to.equal(42); // eslint-disable-line no-underscore-dangle
    expect(view.webContents).to.respondTo('executeJavaScript');
    const created = new bridge.WebContentsView();
    expect(created.__splayerViewId).to.equal(84); // eslint-disable-line no-underscore-dangle
  });

  it('routes dialogs asynchronously', async () => {
    const result = await bridge.dialog.showOpenDialog({ properties: ['openFile'] });
    expect(result).to.deep.equal({ canceled: true, filePaths: [] });
    expect(ipcRenderer.invoke).to.have.been.calledWith(
      'splayer-renderer-bridge-async',
      sinon.match({ operation: 'dialog:open' }),
    );
  });

  it('serializes touch bar callbacks as bridge action identifiers', () => {
    const button = new bridge.TouchBar.TouchBarButton({
      click() {},
      icon: bridge.nativeImage.createFromPath('/tmp/icon.png'),
    });
    bridge.getCurrentWindow().setTouchBar(new bridge.TouchBar({ items: [button] }));
    const request = ipcRenderer.sendSync.lastCall.args[1];

    expect(() => structuredClone(request)).not.to.throw();
    expect(request.args[0].items[0].click).to.equal(undefined);
    expect(request.args[0].items[0].actionId).to.be.a('string');
  });
});
