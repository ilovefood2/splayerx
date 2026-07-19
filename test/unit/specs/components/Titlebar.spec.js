import { shallowMount } from '@vue/test-utils';
import { createStore } from 'vuex';
import { vi } from 'vitest';
import Titlebar from '@/components/Titlebar.vue';

describe('Titlebar window controls', () => {
  it('uses a native button to close the current player window', async () => {
    const close = vi.fn();
    const store = createStore({
      getters: {
        isMaximized: () => false,
        isFullScreen: () => false,
        showSidebar: () => false,
        incognitoMode: () => false,
      },
    });
    const wrapper = shallowMount(Titlebar, {
      global: {
        plugins: [store],
        mocks: {
          $bus: {
            $emit: vi.fn(),
            $on: vi.fn(),
          },
          $electron: {
            ipcRenderer: { send: vi.fn() },
            remote: {
              getCurrentWindow: () => ({
                close,
                isMaximized: () => false,
              }),
            },
          },
          $route: { name: 'landing-view' },
          $t: key => key,
        },
      },
    });

    await wrapper.get('button[aria-label="Close Player"]').trigger('click');

    expect(close).toHaveBeenCalledOnce();
    wrapper.unmount();
  });
});
