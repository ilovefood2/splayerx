import SubtitleManager, { findAITextReference } from '@/store/modules/SubtitleManager';
import { SubtitleManager as subtitleActions } from '@/store/actionTypes';
import { SubtitleManager as subtitleMutations } from '@/store/mutationTypes';
import { Type } from '@/interfaces/ISubtitle';
import { LanguageCode } from '@/libs/language';
import { ipcRenderer } from 'electron';

describe('store/modules/SubtitleManager', () => {
  it('enables and synchronizes the Preferences checkbox for an explicit AI translation', async () => {
    const send = vi.spyOn(ipcRenderer, 'send');
    const dispatches = [];

    await SubtitleManager.actions[subtitleActions.translateWithAI]({
      getters: {
        aiTranslateEnabled: false,
        aiTranslateTargetLanguage: LanguageCode['zh-CN'],
        displayLanguage: LanguageCode.en,
        primaryLanguage: LanguageCode.en,
        list: [],
        primarySubtitleId: '',
      },
      dispatch: (type, payload) => {
        dispatches.push([type, payload]);
        return Promise.resolve();
      },
    });

    expect(dispatches[0]).to.deep.equal(['setPreference', { aiTranslateEnabled: true }]);
    expect(send).toHaveBeenCalledWith(
      'main-to-preference',
      { aiTranslateEnabled: true },
    );
    expect(dispatches[1][0]).to.equal(subtitleActions.transcribeAndTranslate);
  });

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

  it('skips an image-only selected subtitle and uses the next text track', async () => {
    const list = [
      {
        id: 'pgs-japanese', hash: 'pgs', type: Type.Embedded, language: LanguageCode.ja,
      },
      {
        id: 'text-english', hash: 'text', type: Type.Embedded, language: LanguageCode.en,
      },
    ];
    const checked = [];
    const source = await findAITextReference(
      list,
      LanguageCode['zh-CN'],
      'pgs-japanese',
      (id) => {
        checked.push(id);
        return Promise.resolve(id === 'text-english'
          ? [{ start: 0, end: 1, text: 'Hello' }] : []);
      },
    );

    expect(checked).to.deep.equal(['pgs-japanese', 'text-english']);
    expect(source.reference.id).to.equal('text-english');
    expect(source.cues[0].text).to.equal('Hello');
  });

  it('reports no text source when all candidate subtitles are images', async () => {
    const source = await findAITextReference(
      [{
        id: 'pgs-japanese', hash: 'pgs', type: Type.Embedded, language: LanguageCode.ja,
      }],
      LanguageCode['zh-CN'],
      'pgs-japanese',
      () => Promise.resolve([]),
    );

    expect(source).to.equal(undefined);
  });
});
