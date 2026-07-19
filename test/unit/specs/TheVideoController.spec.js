import Vuex from 'vuex';
import { shallowMount } from '@vue/test-utils';
import sinon from 'sinon';
import Window from '@/store/modules/Window';
import Video from '@/store/modules/Video';
import Input from '@/store/modules/Input';
import Playlist from '@/store/modules/Playlist';
import TheVideoController from '@/containers/TheVideoController.vue';
import PlayButton from '@/components/PlayingView/PlayButton.vue';

describe('Component - TheVideoController Unit Test', () => {
  let wrapper;
  let sandbox;
  let store;
  beforeEach(() => {
    store = new Vuex.Store({
      modules: {
        Window: {
          state: Window.state,
          mutations: Window.mutations,
        },
        Video: {
          getters: Video.getters,
        },
        Playlist: {
          state: Playlist.state,
          getters: Playlist.getters,
        },
        Input: {
          state: Input.state,
          mutations: Input.mutations,
          actions: Input.actions,
          getters: Input.getters,
        },
      },
    });
    wrapper = shallowMount(TheVideoController, {
      data() {
        return {
          displayState: {
            AdvanceControl: true,
            PlaylistControl: true,
            RecentPlaylist: false,
          },
          widgetsStatus: {
            AdvanceControl: { showAttached: false },
            PlaylistControl: { showAttached: false },
            RecentPlaylist: { showAttached: false },
          },
        };
      },
      global: {
        plugins: [store],
        // The control bar renders $t() titles; without i18n the render throws and
        // mounted() never sees its $refs.
        mocks: { $t: key => key },
      },
    });
    sandbox = sinon.createSandbox();
  });
  afterEach(() => {
    wrapper.unmount();
    sandbox.restore();
  });

  it('initializes nested widget state before the first Vue 3 render', () => {
    const defaultStateWrapper = shallowMount(TheVideoController, {
      global: {
        plugins: [store],
        mocks: { $t: key => key },
      },
    });

    expect(defaultStateWrapper.vm.widgetsStatus.PlaylistControl.showAttached).to.equal(false);
    expect(defaultStateWrapper.vm.widgetsStatus.AdvanceControl.showAttached).to.equal(false);
    expect(defaultStateWrapper.find('.playlist').exists()).to.equal(true);
    expect(defaultStateWrapper.find('.advance').exists()).to.equal(true);

    defaultStateWrapper.unmount();
  });

  it('Sanity - should component be properly mounted', () => {
    expect(wrapper.findComponent(TheVideoController).exists()).to.equal(true);
  });

  it('lets the parent controller hide every bottom-right control together', async () => {
    wrapper.setData({
      displayState: { PlaylistControl: false, AdvanceControl: false },
    });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.playlist').element.style.display).to.equal('none');
    expect(wrapper.find('.advance').element.style.display).to.equal('none');

    wrapper.setData({
      displayState: { PlaylistControl: true, AdvanceControl: true },
    });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.playlist').element.style.display).to.not.equal('none');
    expect(wrapper.find('.advance').element.style.display).to.not.equal('none');
  });

  it('reveals controls when pointer movement is captured above an overlay', () => {
    wrapper.vm.mouseStopped = true;
    wrapper.vm.mouseLeftWindow = true;

    wrapper.vm.handlePointerActivity();

    expect(wrapper.vm.mouseStopped).to.equal(false);
    expect(wrapper.vm.mouseLeftWindow).to.equal(false);
  });

  it('shows the receiver playback state while casting', async () => {
    store.state.Video.paused = true;
    store.state.Video.casting = true;
    store.state.Video.castPaused = false;
    await wrapper.vm.$nextTick();

    expect(wrapper.vm.controllerPaused).to.equal(false);
    expect(wrapper.findComponent(PlayButton).props('paused')).to.equal(false);

    store.state.Video.castPaused = true;
    await wrapper.vm.$nextTick();

    expect(wrapper.findComponent(PlayButton).props('paused')).to.equal(true);
  });
});
