import Vuex from 'vuex';
import { mount } from '@vue/test-utils';
import Video from '@/store/modules/Video';
import TheTimeCodes from '@/components/PlayingView/TheTimeCodes.vue';

describe('Component - TheTimeCodes', () => {
  let wrapper;
  const store = new Vuex.Store({
    modules: {
      Video: {
        getters: Video.getters,
      },
    },
  });

  beforeEach(() => {
    wrapper = mount(TheTimeCodes, { global: { plugins: [store] } });
  });

  afterEach(() => {
    wrapper.unmount();
  });

  it('sanity - should render correct component', () => {
    expect(wrapper.findComponent(TheTimeCodes).exists()).to.equal(true);
  });
});
