import { mount } from '@vue/test-utils';
import PlayButton from '@/components/PlayingView/PlayButton.vue';
import { vi } from 'vitest';
import fs from 'node:fs';
import { compileStyle, parse } from '@vue/compiler-sfc';

describe('PlayButton.vue', () => {
  const propsData = {
    paused: false,
  };
  let wrapper;
  beforeEach(() => {
    wrapper = mount(PlayButton, { props: propsData });
  });

  afterEach(() => {
    wrapper.unmount();
  });

  it('should changed paused value trigger iconAppear to false', () => {
    wrapper.vm.iconAppear = false;

    wrapper.setProps({ paused: !wrapper.vm.paused });

    expect(wrapper.vm.iconAppear).to.equal(false);
  });

  it('renders the correct icon from the initial paused state', () => {
    const pausedWrapper = mount(PlayButton, { props: { paused: true } });

    expect(pausedWrapper.vm.showPlayIcon).to.equal(true);
    pausedWrapper.unmount();
  });

  it('accepts a visible button click before the controller receives another video tick', async () => {
    const onPlayButtonMouseup = vi.fn();
    await wrapper.setProps({
      isFocused: true, showAllWidgets: false, attachedShown: false, onPlayButtonMouseup,
    });
    await wrapper.trigger('mouseenter');
    const button = wrapper.find('.icon-wrapper');
    expect(button.classes()).to.include('no-drag');
    await button.trigger('mousedown');
    await button.trigger('mouseup');

    expect(onPlayButtonMouseup).toHaveBeenCalledOnce();
    // The icon follows confirmed playback state, not an optimistic local toggle.
    expect(wrapper.vm.showPlayIcon).to.equal(false);
    await wrapper.setProps({ paused: true });
    expect(wrapper.vm.showPlayIcon).to.equal(true);
  });

  it('pauses on the first click even after controls fade out under a stationary pointer', async () => {
    const onPlayButtonMouseup = vi.fn();
    await wrapper.setProps({
      isFocused: true, showAllWidgets: false, attachedShown: false, onPlayButtonMouseup,
    });
    const button = wrapper.find('.icon-wrapper');
    await button.trigger('mousedown');
    await button.trigger('mouseup');

    expect(onPlayButtonMouseup).toHaveBeenCalledOnce();
    expect(wrapper.vm.iconClass).to.equal('fade-in');
    expect(button.classes()).to.include('no-drag');
  });

  it('keeps the faded button hit target visible despite the controller fade-out rule', () => {
    const { descriptor } = parse(fs.readFileSync(
      'src/renderer/components/PlayingView/PlayButton.vue', 'utf8',
    ));
    const style = document.createElement('style');
    style.textContent = '.fade-out { visibility: hidden; }\n' + compileStyle({
      source: descriptor.styles[0].content,
      filename: 'PlayButton.vue',
      id: PlayButton.__scopeId, // eslint-disable-line no-underscore-dangle
      scoped: true,
      preprocessLang: 'scss',
    }).code;
    document.head.append(style);
    document.body.append(wrapper.element);
    try {
      expect(window.getComputedStyle(wrapper.find('.icon-wrapper').element).visibility)
        .to.equal('visible');
    } finally {
      style.remove();
    }
  });

  it('accepts the next button click after the player regains focus', async () => {
    const onPlayButtonMouseup = vi.fn();
    await wrapper.setProps({ isFocused: false, showAllWidgets: true, onPlayButtonMouseup });
    await wrapper.trigger('mouseenter');
    await wrapper.setProps({ isFocused: true });
    const button = wrapper.find('.icon-wrapper');
    await button.trigger('mousedown');
    await button.trigger('mouseup');

    expect(onPlayButtonMouseup).toHaveBeenCalledOnce();
  });

  it.each([
    { isFocused: false, attachedShown: false },
    { isFocused: true, attachedShown: true },
  ])('does not toggle when the player is unfocused or a popup is open: %s', async (props) => {
    const onPlayButtonMouseup = vi.fn();
    await wrapper.setProps({ ...props, showAllWidgets: true, onPlayButtonMouseup });
    const button = wrapper.find('.icon-wrapper');
    await button.trigger('mousedown');
    await button.trigger('mouseup');

    expect(onPlayButtonMouseup).not.toHaveBeenCalled();
  });
});
