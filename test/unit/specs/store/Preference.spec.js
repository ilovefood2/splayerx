import { vi } from 'vitest';
import Preference from '@/store/modules/Preference';
import syncStorage from '@/helpers/syncStorage';

describe('store/modules/Preference', () => {
  it('starts loop modes unchecked even when old preferences contain them', () => {
    const getSync = vi.spyOn(syncStorage, 'getSync').mockReturnValue({
      singleCycle: true,
      playlistLoop: true,
      displayLanguage: 'en',
    });
    const state = { ...Preference.state };

    Preference.mutations.getLocalPreference(state);

    expect(state.singleCycle).to.equal(false);
    expect(state.playlistLoop).to.equal(false);
    expect(state.displayLanguage).to.equal('en');
    getSync.mockRestore();
  });
});
