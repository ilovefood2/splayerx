import { mount } from '@vue/test-utils';
import BaseIconContainer from '@/components/BaseIconContainer.vue';

describe('BaseIconContainer', () => {
  it('forwards native pointer events through the Vue 3 component boundary', async () => {
    const wrapper = mount(BaseIconContainer, {
      props: { type: 'titleBarClose' },
    });

    await wrapper.trigger('click');
    await wrapper.trigger('mouseup');

    expect(wrapper.emitted('click')).to.have.lengthOf(1);
    expect(wrapper.emitted('mouseup')).to.have.lengthOf(1);
    wrapper.unmount();
  });
});
