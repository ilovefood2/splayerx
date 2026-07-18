import SubtitleManager from '@/store/modules/SubtitleManager';
import { SubtitleManager as subtitleActions } from '@/store/actionTypes';

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
      [subtitleActions.autoChangePrimarySubtitle, 'ai-chinese'],
    ]);
    finishStorage();
  });
});
