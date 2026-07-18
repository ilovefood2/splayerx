import Vuex from 'vuex';
import VueI18n from 'vue-i18n';
import { shallowMount, createLocalVue } from '@vue/test-utils';
import Translate from '@/components/Preferences/Translate.vue';
import Preference from '@/store/modules/Preference';
import enMessages from '@/locales/lang/en.json';

const localVue = createLocalVue();
localVue.use(Vuex);
localVue.use(VueI18n);

// Use the real English strings: this also proves the new keys exist.
const i18n = new VueI18n({ locale: 'en', messages: { en: enMessages } });

const flush = () => new Promise(resolve => setTimeout(resolve, 10));

describe('Component - Preferences/Translate', () => {
  let store;
  let originalFetch;

  function mountWith(prefs) {
    store = new Vuex.Store({
      modules: {
        Preference: {
          state: { ...Preference.state, ...prefs },
          getters: Preference.getters,
          // The real mutation, so writing a preference actually moves the store
          // and the component's watchers fire like they do in the app. The real
          // action is not used because it also persists to asyncStorage.
          mutations: Preference.mutations,
          actions: {
            setPreference: ({ commit }, payload) => {
              commit('setPreference', payload);
              return Promise.resolve();
            },
          },
        },
      },
    });
    return shallowMount(Translate, { store, localVue, i18n });
  }

  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  it('uses the app-owned provider without probing another service', async () => {
    global.fetch = () => { throw new Error('managed status must not probe the network'); };
    const wrapper = mountWith({ aiTranslateEnabled: true });
    await flush();
    expect(wrapper.vm.aiTranslateProvider).to.equal('local');
    expect(wrapper.vm.providerStatus.toLowerCase()).to.contain('built-in madlad-400 10b-mt');
    expect(wrapper.vm.defaultModel).to.equal('splayer-madlad400-10b-mt');
    expect(wrapper.vm.aiTranslateManagedModel).to.equal('madlad400-10b-mt');
  });

  it('migrates retired local-provider choices to the built-in provider', async () => {
    const wrapper = mountWith({ aiTranslateEnabled: true, aiTranslateProvider: 'apple' });
    await flush();
    expect(wrapper.vm.aiTranslateProvider).to.equal('local');
    expect(wrapper.vm.providerStatus.toLowerCase()).to.contain('built-in madlad-400 10b-mt');
    const choices = wrapper.findAll('option').wrappers.map(option => option.attributes('value'));
    expect(choices).to.include('local');
    expect(choices).to.not.include('apple');
  });

  it('explains the one-time model download before first translation', async () => {
    const wrapper = mountWith({
      aiTranslateEnabled: true,
      aiTranslateProvider: 'local',
      aiTranslateManagedModel: 'qwen3-14b',
    });
    await flush();
    if (wrapper.vm.managedStatus.runtimeAvailable
      && !wrapper.vm.managedStatus.modelDownloaded) {
      expect(wrapper.vm.providerStatus).to.contain('will download once');
      expect(wrapper.vm.providerStatus).to.contain('9 GB');
    } else if (!wrapper.vm.managedStatus.runtimeAvailable) {
      expect(wrapper.vm.providerStatus).to.contain('development build');
    }
    expect(wrapper.text()).to.contain('Ollama is not required');
  });

  it('lets the user select which built-in model will be downloaded', async () => {
    const wrapper = mountWith({ aiTranslateEnabled: true, aiTranslateProvider: 'local' });
    await flush();
    const choices = wrapper.findAll('option').wrappers.map(option => option.attributes('value'));
    expect(choices).to.include.members(['qwen3-14b', 'qwen3-32b', 'madlad400-10b-mt']);
    expect(choices).to.not.include('qwen3-4b');
    expect(choices).to.not.include('tower-plus-72b');

    wrapper.vm.aiTranslateManagedModel = 'madlad400-10b-mt';
    await flush();
    expect(wrapper.vm.defaultModel).to.equal('splayer-madlad400-10b-mt');
    expect(wrapper.vm.providerStatus).to.contain('MADLAD-400 10B-MT');
    expect(wrapper.vm.selectedManagedModel.downloadSize).to.equal('8.79 GB');
    expect(wrapper.text()).to.contain('MADLAD-400 10B-MT — 8.79 GB');
    expect(wrapper.text()).to.contain('Qwen3 32B — 20 GB');
  });

  it('reports the api key path without probing', async () => {
    global.fetch = () => { throw new Error('should not probe'); };
    const wrapper = mountWith({
      aiTranslateEnabled: true, aiTranslateProvider: 'openai', aiTranslateApiKey: 'sk-test',
    });
    await flush();
    expect(wrapper.vm.providerStatus).to.contain('your API key');
  });

  it('does not let an in-flight probe repopulate the status after being disabled', async () => {
    const wrapper = mountWith({
      aiTranslateEnabled: true, aiTranslateProvider: 'openai', aiTranslateApiKey: 'sk-test',
    });
    wrapper.vm.detectProvider();
    wrapper.vm.aiTranslateEnabled = false;
    await flush();
    expect(wrapper.vm.aiTranslateEnabled).to.equal(false);
    expect(wrapper.vm.resolution).to.equal(null);
    expect(wrapper.vm.providerStatus).to.equal('');
  });

  it('does not probe while the feature is disabled', async () => {
    let probed = false;
    global.fetch = () => { probed = true; return Promise.reject(new Error('x')); };
    const wrapper = mountWith({ aiTranslateEnabled: false });
    await flush();
    expect(probed).to.equal(false);
    expect(wrapper.vm.providerStatus).to.equal('');
  });
});
