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

// Captured from a real `GET /api/tags`.
const TAGS_FIXTURE = {
  models: [
    {
      name: 'bge-m3:latest',
      capabilities: ['embedding'],
      details: { family: 'bert', parameter_size: '566.70M' },
    },
    {
      name: 'qwen3-coder:latest',
      capabilities: ['completion', 'tools'],
      details: { family: 'qwen3moe', parameter_size: '30.5B' },
    },
  ],
};

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

  it('renders and reports the detected local ollama when no api key is set', async () => {
    global.fetch = () => Promise.resolve({
      ok: true, status: 200, json: () => Promise.resolve(TAGS_FIXTURE),
    });
    const wrapper = mountWith({ aiTranslateEnabled: true });
    await flush();
    expect(wrapper.vm.providerStatus).to.contain('local Ollama');
    // the model it will actually use, not a hardcoded default
    expect(wrapper.vm.providerStatus).to.contain('qwen3-coder:latest');
    expect(wrapper.vm.defaultModel).to.equal('qwen3-coder:latest');
    expect(wrapper.text()).to.contain('qwen3-coder:latest');
  });

  it('tells the user how to install ollama when none is running', async () => {
    global.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    const wrapper = mountWith({ aiTranslateEnabled: true });
    await flush();
    expect(wrapper.vm.providerStatus).to.contain('No Ollama found');
    expect(wrapper.vm.providerStatus).to.contain('ollama pull');
  });

  it('names the host it actually probed, not the default one', async () => {
    // A user pointing at an Ollama on another machine must not be told that
    // 127.0.0.1 is unreachable — they would go looking in the wrong place.
    const probedUrls = [];
    global.fetch = (url) => {
      probedUrls.push(url);
      return Promise.reject(new TypeError('Failed to fetch'));
    };
    const wrapper = mountWith({
      aiTranslateEnabled: true,
      aiTranslateProvider: 'ollama',
      aiTranslateApiUrl: 'http://192.168.1.9:11434',
    });
    await flush();
    expect(probedUrls.join(' ')).to.contain('192.168.1.9');
    expect(wrapper.vm.providerStatus).to.contain('192.168.1.9');
    expect(wrapper.vm.providerStatus).to.not.contain('127.0.0.1');
  });

  it('reports the api key path without probing', async () => {
    global.fetch = () => { throw new Error('should not probe'); };
    const wrapper = mountWith({ aiTranslateEnabled: true, aiTranslateApiKey: 'sk-test' });
    await flush();
    expect(wrapper.vm.providerStatus).to.contain('your API key');
  });

  it('does not claim "nothing leaves your computer" for a remote ollama host', async () => {
    // The endpoint field is honoured in forced-ollama mode, so "Ollama" does not
    // imply "on this machine" — subtitle text really does cross the network here.
    global.fetch = () => Promise.resolve({
      ok: true, status: 200, json: () => Promise.resolve(TAGS_FIXTURE),
    });
    const wrapper = mountWith({
      aiTranslateEnabled: true,
      aiTranslateProvider: 'ollama',
      aiTranslateApiUrl: 'http://192.168.1.50:11434',
    });
    await flush();
    expect(wrapper.vm.providerStatus).to.not.contain('nothing leaves your computer');
    expect(wrapper.vm.providerStatus).to.contain('192.168.1.50');
    expect(wrapper.vm.providerStatus).to.contain('over your network');
  });

  it('still says nothing leaves your computer for a genuinely local ollama', async () => {
    global.fetch = () => Promise.resolve({
      ok: true, status: 200, json: () => Promise.resolve(TAGS_FIXTURE),
    });
    const wrapper = mountWith({ aiTranslateEnabled: true, aiTranslateProvider: 'ollama' });
    await flush();
    expect(wrapper.vm.providerStatus).to.contain('nothing leaves your computer');
  });

  it('ignores a stale probe that lands after a newer one', async () => {
    // Typing in the endpoint field fires a probe per keystroke; they can finish
    // out of order, and the slow early one must not overwrite the newer answer.
    let call = 0;
    global.fetch = () => {
      call += 1;
      if (call === 1) {
        // slow probe that reports a working local ollama
        return new Promise(resolve => setTimeout(() => resolve({
          ok: true, status: 200, json: () => Promise.resolve(TAGS_FIXTURE),
        }), 60));
      }
      return Promise.reject(new TypeError('Failed to fetch')); // fast, fails
    };
    const wrapper = mountWith({ aiTranslateEnabled: true });
    wrapper.vm.detectProvider(); // supersedes the mounted() probe
    await flush();
    await new Promise(resolve => setTimeout(resolve, 120)); // let the stale one land
    expect(wrapper.vm.providerStatus).to.contain('No Ollama found');
  });

  it('does not let an in-flight probe repopulate the status after being disabled', async () => {
    global.fetch = () => new Promise(resolve => setTimeout(() => resolve({
      ok: true, status: 200, json: () => Promise.resolve(TAGS_FIXTURE),
    }), 40));
    const wrapper = mountWith({ aiTranslateEnabled: true });
    wrapper.vm.detectProvider();
    wrapper.vm.aiTranslateEnabled = false; // disable while the probe is in flight
    await flush();
    expect(wrapper.vm.aiTranslateEnabled).to.equal(false); // the store really moved
    await new Promise(resolve => setTimeout(resolve, 100)); // let the stale probe land
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
