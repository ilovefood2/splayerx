import { createApp } from 'vue';
import osLocale from 'os-locale';
import { createI18n } from 'vue-i18n';
import electron, { ipcRenderer } from 'electron';
import messages from '@/locales';
import { hookVue } from '@/kerning';
import { installRendererGlobals } from '@/bootstrap';
import About from '@/components/About.vue';
import asyncStorage from '@/helpers/asyncStorage';
import '@/css/style.scss';


function getSystemLocale() {
  const { app } = electron.remote;
  const locale = process.platform === 'win32' ? app.getLocale() : osLocale.sync();
  if (locale === 'zh-TW' || locale === 'zh-HK' || locale === 'zh-Hant') {
    return 'zh-Hant';
  }
  if (locale.startsWith('zh')) {
    return 'zh-Hans';
  }
  return 'en';
}

const i18n = createI18n({
  legacy: true,
  locale: getSystemLocale(), // set locale
  fallbackLocale: 'en',
  messages, // set locale messages
});

const app = createApp({
  components: { About },
  mounted() {
    asyncStorage.get('preferences').then((data) => {
      if (data.displayLanguage) {
        this.$i18n.locale = data.displayLanguage;
      }
    });
    ipcRenderer.on('setPreference', (event, data) => {
      if (data && data.displayLanguage) {
        this.$i18n.locale = data.displayLanguage;
      }
    });
  },
  template: '<About/>',
});
installRendererGlobals(app);
app.use(i18n);
hookVue(app);
app.mount('#app');
