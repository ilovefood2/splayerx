import fs from 'fs';
import path from 'path';
import sinon from 'sinon';
import helpers from '@/helpers';
import { mediaQuickHash } from '@/libs/utils';

describe('network location opening', () => {
  let sandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('reads a folder once with directory entries and never stats every child', async () => {
    const directory = path.join(path.sep, 'Volumes', 'Shows');
    const entries = [
      { name: 'Episode 2.mkv', isDirectory: () => false },
      { name: 'Episode 10.mp4', isDirectory: () => false },
      { name: 'Episode 2.srt', isDirectory: () => false },
      { name: '.metadata.mp4', isDirectory: () => false },
      { name: 'Extras', isDirectory: () => true },
    ];
    const readdir = sandbox.stub(fs.promises, 'readdir').callsFake((currentDirectory) => (
      currentDirectory === directory ? Promise.resolve(entries) : Promise.resolve([])
    ));
    const createPlayList = sandbox.stub().resolves();
    const emit = sinon.spy();

    await helpers.methods.openFolder.call({
      createPlayList,
      $bus: { $emit: emit },
    }, directory);

    sinon.assert.calledWithExactly(readdir, directory, { withFileTypes: true });
    sinon.assert.calledWithExactly(
      readdir, path.join(directory, 'Extras'), { withFileTypes: true },
    );
    sinon.assert.calledOnceWithExactly(
      createPlayList,
      path.join(directory, 'Episode 2.mkv'),
      path.join(directory, 'Episode 10.mp4'),
    );
    sinon.assert.calledWithExactly(emit, 'add-subtitles', [{
      src: path.join(directory, 'Episode 2.srt'),
      type: 'local',
    }]);
  });

  it('starts the first video while the rest of the network playlist indexes', async () => {
    let finishIndexing;
    const indexing = new Promise((resolve) => {
      finishIndexing = resolve;
    });
    sandbox.stub(mediaQuickHash, 'try').resolves('first-hash');
    const dispatch = sinon.spy();
    const commit = sinon.spy();
    const emit = sinon.spy();
    const infoDB = {
      addPlaylist: sinon.stub().returns(indexing),
      get: sinon.stub().resolves({
        id: 17,
        items: [101, 102],
        playedIndex: 0,
      }),
    };
    const context = {
      infoDB,
      $store: {
        dispatch,
        commit,
        getters: {
          playingList: ['/network/Episode 1.mkv', '/network/Episode 2.mkv'],
          originSrc: '/network/Episode 1.mkv',
        },
      },
      $router: {
        currentRoute: { value: { name: 'landing-view' } },
        push: sinon.spy(),
      },
      $bus: { $emit: emit },
    };

    const result = await helpers.methods.createPlayList.call(
      context,
      '/network/Episode 1.mkv',
      '/network/Episode 2.mkv',
    );

    expect(result).to.equal('first-hash');
    sinon.assert.calledWithExactly(dispatch, 'SRC_SET', {
      src: '/network/Episode 1.mkv',
      id: NaN,
      mediaHash: 'first-hash',
    });
    sinon.assert.calledWithExactly(context.$router.push, { name: 'playing-view' });
    sinon.assert.notCalled(infoDB.get);

    finishIndexing(17);
    await Promise.resolve();
    await Promise.resolve();

    sinon.assert.calledWithExactly(commit, 'ID_UPDATE', 101);
    sinon.assert.calledWithExactly(emit, 'open-playlist');
  });
});
