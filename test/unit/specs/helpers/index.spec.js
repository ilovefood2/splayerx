import helpers from '@/helpers';
import fs from 'fs';
import path from 'path';
import sinon from 'sinon';

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

    it('uses one bulk directory read and filters playable files', async () => {
      const entries = [
        { name: 'Episode 10.mkv', isDirectory: () => false },
        { name: 'Episode 2.mp4', isDirectory: () => false },
        { name: 'notes.txt', isDirectory: () => false },
        { name: '.hidden.mp4', isDirectory: () => false },
        { name: 'bonus.mp4', isDirectory: () => true },
      ];
      const readdir = sandbox.stub(fs.promises, 'readdir').resolves(entries);
      const directory = path.join(path.sep, 'network', 'shows');

      const result = await helpers.methods.findSimilarVideoByVidPath(
        path.join(directory, 'Episode 2.mp4'),
      );

      expect(result).to.deep.equal([
        path.join(directory, 'Episode 2.mp4'),
        path.join(directory, 'Episode 10.mkv'),
      ]);
      sinon.assert.calledOnce(readdir);
      expect(readdir.firstCall.args[1]).to.deep.equal({ withFileTypes: true });
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
          currentRoute: { name: 'playing-view' },
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
  });
});
