import { shallowMount } from '@vue/test-utils';
import Vuex from 'vuex';
import sinon from 'sinon';
import Video from '@/store/modules/Video';
import ThePreviewThumbnail from '@/containers/ThePreviewThumbnail.vue';

describe('Component - ThePreviewThumbnail', () => {
  let wrapper;
  let sandbox;
  const store = new Vuex.Store({
    modules: {
      Video: {
        state: Video.state,
        mutations: Video.mutations,
        getters: Video.getters,
      },
    },
  });

  const propsData = {
    src: 'file:///',
    currentTime: 0,
    maxThumbnailWidth: 240,
    videoRatio: 1.78,
    thumbnailWidth: 135,
    thumbnailHeight: 76,
  };
  beforeEach(() => {
    sandbox = sinon.createSandbox();
    wrapper = shallowMount(ThePreviewThumbnail, {
      props: propsData,
      global: { plugins: [store] },
    });
  });
  afterEach(() => {
    wrapper.unmount();
    sandbox.restore();
  });

  it('Sanity - should ThePreviewThumbnail be rendered', () => {
    expect(wrapper.findComponent(ThePreviewThumbnail).exists()).to.equal(true);
  });

  it('should switch currentTime update display and currentTimes', () => {
    wrapper.setProps({ currentTime: 90 });
  });
});
