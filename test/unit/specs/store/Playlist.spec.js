import sinon from 'sinon';
import Playlist from '@/store/modules/Playlist';
import helpers from '@/helpers/index';

describe('store/modules/Playlist', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('keeps media IDs attached to their paths when a folder scan inserts earlier files', () => {
    const state = {
      playList: ['/library/chapter/b.mp4'],
      items: [42],
    };
    Playlist.mutations.playList(state, ['/library/a.mp4', '/library/chapter/b.mp4']);

    expect(state.items).to.deep.equal([undefined, 42]);
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
