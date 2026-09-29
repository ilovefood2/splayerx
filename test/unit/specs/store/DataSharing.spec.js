import Preference from '@/store/modules/Preference';
import SubtitleManager from '@/store/modules/SubtitleManager';
import Subtitle from '@/store/modules/Subtitle';
import { SubtitleManager as subtitleActions, newSubtitle as newSubtitleActions } from '@/store/actionTypes';
import { SHARE_DATA_WITH_SERVERS } from '@/../shared/privacy';
import { getConfig, isBrowserEnabled } from '@/../shared/config';

describe('data sharing is disabled', () => {
  it('is switched off', () => {
    expect(SHARE_DATA_WITH_SERVERS).to.equal(false);
  });

  it('uses built-in feature flags instead of fetching them with the client ID', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    try {
      expect(await getConfig('anything', 42)).to.equal(42);
      expect(await isBrowserEnabled()).to.equal(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('treats a stored "upload anonymous data" opt-in as declined', () => {
    expect(Preference.getters.privacyAgreement({ privacyAgreement: true })).to.equal(false);
  });

  it('never searches for online subtitles', async () => {
    const dispatch = vi.fn();
    const result = await SubtitleManager.actions[subtitleActions.refreshOnlineSubtitles](
      {
        getters: { originSrc: '/Movies/show.mkv', primaryLanguage: 'en', secondaryLanguage: 'zh-CN' },
        dispatch,
      },
      { mediaHash: 'hash', bubble: true },
    );

    expect(result).to.equal(undefined);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('never uploads a subtitle, automatically or on request', async () => {
    const context = {
      state: { hash: 'subtitle-hash', format: 'srt' },
      getters: { canAutoUpload: true, canUpload: true, isImage: false },
      commit: vi.fn(),
    };

    await expect(Subtitle.actions[newSubtitleActions.upload](context)).rejects.toThrow();
    await expect(Subtitle.actions[newSubtitleActions.manualUpload](context)).rejects.toThrow();
    expect(context.commit).not.toHaveBeenCalled();
  });

  it('does not upload subtitles from the menu command', async () => {
    const dispatch = vi.fn();
    await SubtitleManager.actions[subtitleActions.manualUploadAllSubtitles]({
      state: { primarySubtitleId: 'a', secondarySubtitleId: 'b' },
      dispatch,
      rootGetters: {},
    });

    expect(dispatch).not.toHaveBeenCalled();
  });
});
