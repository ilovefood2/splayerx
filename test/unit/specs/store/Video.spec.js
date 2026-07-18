import Video from '@/store/modules/Video';
import { Video as videoActions, Subtitle as subtitleActions } from '@/store/actionTypes';
import { Video as videoMutations } from '@/store/mutationTypes';

describe('store/modules/Video', () => {
  it('assigns a normal media source before calculating its hash', async () => {
    const state = { src: '' };
    const commits = [];
    const dispatches = [];
    const commit = (type, payload) => {
      commits.push([type, payload]);
      if (type === videoMutations.SRC_UPDATE) state.src = payload;
    };
    const dispatch = (type, payload) => dispatches.push([type, payload]);
    const src = './test/assets/test.avi';

    const opening = Video.actions[videoActions.SRC_SET](
      { state, commit, dispatch },
      { src, id: 7 },
    );

    expect(commits).to.deep.equal([
      [videoMutations.CURRENT_SRC_UPDATE, src],
      [videoMutations.MEDIA_HASH_UPDATE, ''],
      [videoMutations.ID_UPDATE, 7],
      [videoMutations.SRC_UPDATE, src],
    ]);
    expect(dispatches).to.deep.equal([
      [subtitleActions.INITIALIZE_VIDEO_SUBTITLE_MAP, { videoSrc: src }],
    ]);

    const mediaHash = await opening;
    expect(mediaHash).to.be.a('string').and.not.equal('');
    expect(commits[commits.length - 1]).to.deep.equal([
      videoMutations.MEDIA_HASH_UPDATE,
      mediaHash,
    ]);
  });
});
