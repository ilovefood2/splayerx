import SubtitleManager from '@/store/modules/SubtitleManager';
import { SubtitleManager as subtitleActions } from '@/store/actionTypes';
import { SubtitleManager as subtitleMutations } from '@/store/mutationTypes';

describe('store/modules/SubtitleManager', () => {
  it('selects an AI subtitle without waiting for preference storage', async () => {
    let finishStorage;
    const storage = new Promise((resolve) => { finishStorage = resolve; });
    const dispatches = [];
    const dispatch = (type, payload) => {
      dispatches.push([type, payload]);
      return type === 'setSubtitleOff' ? storage : Promise.resolve();
    };

    await SubtitleManager.actions[subtitleActions.manualChangePrimarySubtitle](
      { dispatch, commit: () => {}, state: { secondarySubtitleId: 'secondary' } },
      'ai-chinese',
    );

    expect(dispatches).to.deep.equal([
      ['setSubtitleOff', false],
      [subtitleActions.autoChangePrimarySubtitle, { id: 'ai-chinese', explicit: true }],
    ]);
    finishStorage();
  });

  it('re-enables an explicitly selected subtitle while Off is still clearing', async () => {
    const state = {
      primarySubtitleId: '',
      secondarySubtitleId: 'NOT_SELECTED_SUBTITLE',
      allSubtitles: {
        chinese: { delay: 0 },
      },
    };
    const commits = [];
    const dispatches = [];
    const commit = (type, payload) => {
      commits.push([type, payload]);
      if (type === subtitleMutations.setPrimarySubtitleId) state.primarySubtitleId = payload;
    };

    await SubtitleManager.actions[subtitleActions.autoChangePrimarySubtitle](
      {
        dispatch: (type, payload) => {
          dispatches.push([type, payload]);
          return Promise.resolve();
        },
        commit,
        getters: { subtitleOff: true },
        state,
      },
      { id: 'chinese', explicit: true },
    );

    expect(commits).to.include.deep.members([
      [subtitleMutations.setPrimarySubtitleId, 'chinese'],
      [subtitleMutations.setPrimaryDelay, 0],
    ]);
    expect(dispatches).to.include.deep.members([
      [subtitleActions.storeSelectedSubtitles, ['chinese', 'NOT_SELECTED_SUBTITLE']],
    ]);
  });
});
