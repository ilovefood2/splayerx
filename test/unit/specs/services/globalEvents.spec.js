import { mount } from '@vue/test-utils';
import { installRendererGlobals } from '@/bootstrap';
import { RendererEventBus, ScopedEventBus, rendererEventBus } from '@/services/globalEvents';

const countOf = (bus, eventName) => {
  const handlers = bus.listeners.get(eventName);
  return handlers ? handlers.size : 0;
};

describe('renderer event bus', () => {
  it('removes only the listeners a scope added when it is disposed', () => {
    const bus = new RendererEventBus();
    const scope = new ScopedEventBus(bus);
    const kept = vi.fn();
    const scoped = vi.fn();
    bus.$on('seek', kept);
    scope.$on('seek', scoped);
    scope.$once('seek', scoped);

    scope.dispose();
    bus.$emit('seek', 10);

    expect(kept).toHaveBeenCalledWith(10);
    expect(scoped).not.toHaveBeenCalled();
  });

  it('delivers a scoped $once exactly once', () => {
    const bus = new RendererEventBus();
    const scope = new ScopedEventBus(bus);
    const handler = vi.fn();
    scope.$once('saved', handler);

    bus.$emit('saved');
    bus.$emit('saved');

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('drops a component\'s listeners when it unmounts, so reopening does not stack them', () => {
    const toggles = vi.fn();
    const Player = {
      render: () => null,
      mounted() { this.$bus.$on('toggle-playback', toggles); },
    };
    const install = { install: app => installRendererGlobals(app) };
    const before = countOf(rendererEventBus, 'toggle-playback');

    // Open the player, go back, open it again: the old instance must be gone.
    mount(Player, { global: { plugins: [install] } }).unmount();
    const second = mount(Player, { global: { plugins: [install] } });

    expect(countOf(rendererEventBus, 'toggle-playback')).to.equal(before + 1);
    rendererEventBus.$emit('toggle-playback');
    expect(toggles).toHaveBeenCalledTimes(1);

    second.unmount();
    expect(countOf(rendererEventBus, 'toggle-playback')).to.equal(before);
  });
});
