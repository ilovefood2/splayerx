import { mount } from '@vue/test-utils';
import BaseCheckBox from '@/components/Preferences/BaseCheckBox.vue';

describe('Component - Preferences/BaseCheckBox', () => {
  it('renders the checked state directly from modelValue', () => {
    const wrapper = mount(BaseCheckBox, {
      props: { modelValue: true },
      slots: { default: 'AI translation' },
    });

    expect(wrapper.get('input').element.checked).to.equal(true);
    expect(wrapper.get('.checkbox__checkmark').classes())
      .to.include('checkbox__checkmark--checked');
  });

  it('updates the native and visible state when the preference changes', async () => {
    const wrapper = mount(BaseCheckBox, { props: { modelValue: false } });

    await wrapper.setProps({ modelValue: true });

    expect(wrapper.get('input').element.checked).to.equal(true);
    expect(wrapper.get('.checkbox__checkmark').classes())
      .to.include('checkbox__checkmark--checked');
  });

  it('emits the new value when clicked', async () => {
    const wrapper = mount(BaseCheckBox, { props: { modelValue: false } });
    await wrapper.get('input').setValue(true);

    expect(wrapper.emitted('update:modelValue')[0]).to.deep.equal([true]);
  });

  it('supports Vue 2 compatibility-mode value/input bindings', async () => {
    const wrapper = mount(BaseCheckBox, { props: { value: true } });

    expect(wrapper.get('input').element.checked).to.equal(true);
    expect(wrapper.get('.checkbox__checkmark').classes())
      .to.include('checkbox__checkmark--checked');

    await wrapper.setProps({ value: false });
    expect(wrapper.get('input').element.checked).to.equal(false);

    await wrapper.get('input').setValue(true);
    expect(wrapper.emitted('input')[0]).to.deep.equal([true]);
    expect(wrapper.emitted('update:modelValue')[0]).to.deep.equal([true]);
  });
});
