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
      get: sinon.stub().callsFake((schema) => {
        if (schema === 'recent-played') {
          return Promise.resolve({
            id: 17,
            items: [101, 102],
            hpaths: [
              'first-hash-/network/Episode 1.mkv',
              'second-hash-/network/Episode 2.mkv',
            ],
            playedIndex: 0,
          });
        }
        // media-item lookup: this network folder has not been played before.
        return Promise.resolve(undefined);
      }),
    };
    const context = {
      infoDB,
      $store: {
        dispatch,
        commit,
        getters: {
          incognitoMode: false,
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
    // Playback starts without waiting for the folder to finish indexing: the
    // recent-played record is only read after addPlaylist resolves.
    sinon.assert.neverCalledWith(infoDB.get, 'recent-played');

    finishIndexing(17);
    await Promise.resolve();
    await Promise.resolve();

    // The playing file is matched by path, not position, so a skipped (hash-failed)
    // earlier item can't shift the id onto the wrong video.
    sinon.assert.calledWithExactly(commit, 'ID_UPDATE', 101);
    sinon.assert.calledWithExactly(emit, 'open-playlist');
  });

  it('resumes a previously-played first video without waiting for indexing', async () => {
    const indexing = new Promise(() => {}); // never resolves: only the fast path matters here
    sandbox.stub(mediaQuickHash, 'try').resolves('first-hash');
    const dispatch = sinon.spy();
    const infoDB = {
      addPlaylist: sinon.stub().returns(indexing),
      get: sinon.stub().callsFake((schema, index) => {
        if (schema === 'media-item' && index === 'path') {
          return Promise.resolve({
            videoId: 42,
            quickHash: 'first-hash',
            path: '/network/Movie.mkv',
          });
        }
        return Promise.resolve(undefined);
      }),
    };
    const context = {
      infoDB,
      $store: {
        dispatch,
        commit: sinon.spy(),
        getters: {
          incognitoMode: false,
          playingList: ['/network/Movie.mkv'],
          originSrc: '/network/Movie.mkv',
        },
      },
      $router: {
        currentRoute: { value: { name: 'playing-view' } },
        push: sinon.spy(),
      },
      $bus: { $emit: sinon.spy() },
    };

    await helpers.methods.createPlayList.call(context, '/network/Movie.mkv');

    // The saved media-item id is used up front, so onMetaLoaded can restore the
    // last-played position instead of starting the video from zero.
    sinon.assert.calledWithExactly(dispatch, 'SRC_SET', {
      src: '/network/Movie.mkv',
      id: 42,
      mediaHash: 'first-hash',
    });
  });

  it('opens a mounted-volume folder lazily without hashing every file', async () => {
    const dispatch = sinon.spy();
    const openVideoFile = sinon.stub().resolves();
    const emit = sinon.spy();
    const addPlaylist = sinon.stub().resolves();
    const context = {
      infoDB: { addPlaylist },
      openVideoFile,
      $store: { dispatch, getters: {} },
      $bus: { $emit: emit },
    };

    await helpers.methods.createPlayList.call(
      context,
      '/Volumes/Share/Episode 1.mp4',
      '/Volumes/Share/Episode 2.mp4',
    );

    // Every folder path is kept for the playlist panel and next/previous nav.
    sinon.assert.calledWithExactly(dispatch, 'FolderList', {
      id: '',
      paths: ['/Volumes/Share/Episode 1.mp4', '/Volumes/Share/Episode 2.mp4'],
      items: [],
    });
    // Only the first file is opened, lazily, keeping the folder list intact.
    sinon.assert.calledWithExactly(
      openVideoFile, '/Volumes/Share/Episode 1.mp4', { keepCurrentFolderList: true },
    );
    // Crucially: the whole folder is NOT fingerprinted up front over the network.
    sinon.assert.notCalled(addPlaylist);
  });
});
