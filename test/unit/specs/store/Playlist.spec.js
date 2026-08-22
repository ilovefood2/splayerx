import sinon from 'sinon';
import Playlist from '@/store/modules/Playlist';
import helpers from '@/helpers/index';

describe('store/modules/Playlist', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('keeps an existing multi-file folder queue across nested folders', () => {
    const findSimilar = sinon.stub(helpers.methods, 'findSimilarVideoByVidPath');
    const state = {
      isFolderList: true,
      playList: ['/library/one.jpg', '/library/chapter/two.mp4'],
      items: [],
      id: NaN,
    };

    Playlist.actions.UpdatePlayingList({
      state,
      dispatch: sinon.spy(),
      commit: sinon.spy(),
    });

    sinon.assert.notCalled(findSimilar);
  });
});
