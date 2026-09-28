import fs from 'fs';
import path from 'path';
import sinon from 'sinon';
import helpers from '@/helpers';

describe('index.js', () => {
  describe('timecodeFromSeconds method works fine', () => {
    it('should display correct time codes', () => {
      const expectArray = ['00:00', '00:01', '00:10', '01:00', '01:01', '10:01',
        '1:01:01', '11:11:11'];

      const functionArray = [0, 1, 10, 60, 61, 601, 3661, 40271];
      let i;
      let expectedResult;
      let functionResult;

      for (i = 0; i < expectArray.length; i += 1) {
        expectedResult = expectArray[i];
        functionResult = helpers.methods.timecodeFromSeconds(functionArray[i]);
        expect(functionResult).to.be.equal(expectedResult);
      }
    });
  });

  describe('findSimilarVideoByVidPath', () => {
    let sandbox;

    beforeEach(() => {
      sandbox = sinon.createSandbox();
    });

    afterEach(() => {
      sandbox.restore();
    });

    it('recursively includes playable files from nested folders', async () => {
      const directory = path.join(path.sep, 'network', 'shows');
      const nestedDirectory = path.join(directory, 'bonus');
      const entries = {
        [directory]: [
          { name: 'Episode 10.mkv', isDirectory: () => false },
          { name: 'Episode 2.mp4', isDirectory: () => false },
          { name: 'notes.txt', isDirectory: () => false },
          { name: '.hidden.mp4', isDirectory: () => false },
          { name: 'bonus', isDirectory: () => true },
        ],
        [nestedDirectory]: [
          { name: 'Episode 3.jpg', isDirectory: () => false },
          { name: 'Episode 4.mp4', isDirectory: () => false },
        ],
      };
      const readdir = sandbox.stub(fs.promises, 'readdir').callsFake(currentDirectory => (
        Promise.resolve(entries[currentDirectory] || [])
      ));

      const result = await helpers.methods.findSimilarVideoByVidPath(
        path.join(directory, 'Episode 2.mp4'),
      );

      expect(result).to.deep.equal([
        path.join(directory, 'Episode 2.mp4'),
        path.join(nestedDirectory, 'Episode 3.jpg'),
        path.join(nestedDirectory, 'Episode 4.mp4'),
        path.join(directory, 'Episode 10.mkv'),
      ]);
      sinon.assert.calledWithExactly(readdir, directory, { withFileTypes: true });
      sinon.assert.calledWithExactly(readdir, nestedDirectory, { withFileTypes: true });
    });

    it('falls back to siblings instead of walking a huge tree (e.g. the home folder)', async () => {
      const home = path.join(path.sep, 'Users', 'someone');
      const readdir = sandbox.stub(fs.promises, 'readdir').callsFake((currentDirectory) => {
        if (currentDirectory === home) {
          return Promise.resolve([
            { name: 'b.mp4', isDirectory: () => false },
            { name: 'a.mp4', isDirectory: () => false },
            { name: 'Library', isDirectory: () => true },
          ]);
        }
        // Every directory below has two more: an effectively unbounded tree,
        // full of cached thumbnails.
        return Promise.resolve([
          { name: 'x', isDirectory: () => true },
          { name: 'y', isDirectory: () => true },
          { name: 'thumb.jpg', isDirectory: () => false },
        ]);
      });

      const result = await helpers.methods.findSimilarVideoByVidPath(path.join(home, 'a.mp4'));

      expect(result).to.deep.equal([path.join(home, 'a.mp4'), path.join(home, 'b.mp4')]);
      // Bounded: the budget plus the sibling-only fallback read.
      expect(readdir.callCount).to.be.at.most(257 + 1);
    });

    it('never descends into macOS package directories', async () => {
      const directory = path.join(path.sep, 'Movies');
      const entries = {
        [directory]: [
          { name: 'clip.mp4', isDirectory: () => false },
          { name: 'Photos Library.photoslibrary', isDirectory: () => true },
          { name: 'Player.app', isDirectory: () => true },
          { name: 'Season 1', isDirectory: () => true },
        ],
        [path.join(directory, 'Photos Library.photoslibrary')]: [
          { name: 'IMG_0001.jpg', isDirectory: () => false },
        ],
        [path.join(directory, 'Player.app')]: [
          { name: 'AppIcon.png', isDirectory: () => false },
        ],
        [path.join(directory, 'Season 1')]: [
          { name: 'Episode 1.mp4', isDirectory: () => false },
        ],
      };
      sandbox.stub(fs.promises, 'readdir').callsFake(currentDirectory => (
        Promise.resolve(entries[currentDirectory] || [])
      ));

      const result = await helpers.methods.findSimilarVideoByVidPath(path.join(directory, 'clip.mp4'));

      // Real subfolders still continue the queue; package contents never do.
      expect(result).to.have.members([
        path.join(directory, 'clip.mp4'),
        path.join(directory, 'Season 1', 'Episode 1.mp4'),
      ]);
    });

    it('handles file names containing a literal percent sign', async () => {
      const directory = path.join(path.sep, 'Movies');
      sandbox.stub(fs.promises, 'readdir').callsFake(currentDirectory => Promise.resolve(
        currentDirectory === directory
          ? [
            { name: '100% Real.mp4', isDirectory: () => false },
            { name: 'My%20Clip.mp4', isDirectory: () => false },
          ]
          : [],
      ));

      // decodeURI() on these plain paths used to throw (or rewrite "%20"),
      // which broke next/auto-advance for the file.
      const result = await helpers.methods.findSimilarVideoByVidPath(
        path.join(directory, '100% Real.mp4'),
      );

      expect(result).to.deep.equal([
        path.join(directory, '100% Real.mp4'),
        path.join(directory, 'My%20Clip.mp4'),
      ]);
    });
  });

  describe('openFolder', () => {
    it('recursively collects nested images and videos in playback order', async () => {
      const sandbox = sinon.createSandbox();
      const directory = path.join(path.sep, 'library');
      const nestedDirectory = path.join(directory, 'chapter');
      const entries = {
        [directory]: [
          { name: '01-cover.jpg', isDirectory: () => false },
          { name: 'chapter', isDirectory: () => true },
        ],
        [nestedDirectory]: [
          { name: '02-clip.mp4', isDirectory: () => false },
          { name: '03-page.png', isDirectory: () => false },
        ],
      };
      const readdir = sandbox.stub(fs.promises, 'readdir').callsFake(currentDirectory => (
        Promise.resolve(entries[currentDirectory] || [])
      ));
      const createPlayList = sandbox.stub().resolves();

      try {
        await helpers.methods.openFolder.call({
          createPlayList,
          $bus: { $emit: sinon.spy() },
        }, directory);

        sinon.assert.calledWithExactly(
          createPlayList,
          path.join(directory, '01-cover.jpg'),
          path.join(nestedDirectory, '02-clip.mp4'),
          path.join(nestedDirectory, '03-page.png'),
        );
        sinon.assert.calledWithExactly(
          readdir, nestedDirectory, { withFileTypes: true },
        );
      } finally {
        sandbox.restore();
      }
    });
  });

  describe('playFile', () => {
    it('reuses a known media hash instead of reading the file again', async () => {
      const dispatch = sinon.stub().resolves();
      const emit = sinon.spy();
      const context = {
        $store: {
          getters: { showSidebar: false, source: '' },
          dispatch,
        },
        $router: {
          currentRoute: { value: { name: 'playing-view' } },
          push: sinon.spy(),
        },
        $bus: { $emit: emit },
      };

      await helpers.methods.playFile.call(context, '/network/movie.mkv', 42, 'known-hash');

      sinon.assert.calledWithExactly(dispatch, 'SRC_SET', {
        src: '/network/movie.mkv',
        mediaHash: 'known-hash',
        id: 42,
      });
      sinon.assert.calledWithExactly(emit, 'new-file-open');
    });

    it('starts opening before deferred source preparation finishes', async () => {
      let finishOpening;
      const sourceResult = new Promise((resolve) => { finishOpening = resolve; });
      const dispatch = sinon.stub().returns(sourceResult);
      const emit = sinon.spy();
      const context = {
        $store: {
          getters: { showSidebar: false, source: '' },
          dispatch,
        },
        $router: {
          currentRoute: { value: { name: 'landing-view' } },
          push: sinon.spy(),
        },
        $bus: { $emit: emit },
      };

      const opening = helpers.methods.playFile.call(context, '/network/movie.mkv', NaN);

      sinon.assert.calledOnce(dispatch);
      sinon.assert.calledWithExactly(context.$router.push, { name: 'playing-view' });
      sinon.assert.calledWithExactly(emit, 'new-file-open');
      finishOpening('calculated-hash');
      expect(await opening).to.equal('calculated-hash');
    });
  });
});
