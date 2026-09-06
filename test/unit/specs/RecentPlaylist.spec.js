import Vuex from 'vuex';
import { shallowMount } from '@vue/test-utils';
import RecentPlaylistItem from '@/containers/RecentPlaylistItem.vue';

describe('RecentPlaylist.vue', () => {
  function mountItem({ isInRange = false, isPlaying = false } = {}) {
    const store = new Vuex.Store({
      getters: {
        playingList: () => ['/Volumes/share/one.mp4'],
        items: () => [],
        hideNSFW: () => false,
        isFolderList: () => true,
        nsfwProcessDone: () => true,
      },
    });
    return shallowMount(RecentPlaylistItem, {
      props: {
        index: 0,
        path: '/Volumes/share/one.mp4',
        isInRange,
        isPlaying,
        onItemMousemove: () => {},
        onItemMousedown: () => {},
        onItemMouseup: () => {},
        onItemMouseout: () => {},
        onItemMouseover: () => {},
      },
      global: {
        plugins: [store],
        mocks: { $t: key => key },
      },
    });
  }

  it('does not probe hidden folder items until they enter the visible page', async () => {
    const wrapper = mountItem();
    expect(wrapper.vm.recentPlayService).to.equal(null);

    await wrapper.setProps({ isInRange: true });
    expect(wrapper.vm.recentPlayService).to.not.equal(null);

    wrapper.unmount();
  });

  it('loads the playing item even when it is outside the visible page', () => {
    const wrapper = mountItem({ isPlaying: true });
    expect(wrapper.vm.recentPlayService).to.not.equal(null);
    wrapper.unmount();
  });
});
