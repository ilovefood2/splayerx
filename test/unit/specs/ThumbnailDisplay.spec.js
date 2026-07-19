import { mount } from '@vue/test-utils';
import sinon from 'sinon';
import ThumbnailDisplay from '@/components/PlayingView/ThumbnailDisplay.vue';

describe('Component - ThumbnailDisplay', () => {
  let wrapper;
  let sandbox;
  const propsData = {
    currentTime: 0,
  };
  beforeEach(() => {
    sandbox = sinon.createSandbox();
    wrapper = mount(ThumbnailDisplay, { props: propsData });
  });
  afterEach(() => {
    wrapper.unmount();
    sandbox.restore();
  });

  it('renders the thumbnail display', () => {
    expect(wrapper.findComponent(ThumbnailDisplay).exists()).to.equal(true);
  });
});
