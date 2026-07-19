import { createApp } from 'vue';
import { createI18n } from 'vue-i18n';
import { hookVue } from '@/kerning';
import { installRendererGlobals } from '@/bootstrap';
import messages from '@/locales';
import store from '@/store';
import '@/css/style.scss';
// @ts-ignore
import DownloadList from './DownloadList.vue';

const i18n = createI18n({
  legacy: true,
  // @ts-ignore
  locale: window.displayLanguage, // set locale
  fallbackLocale: 'en',
  messages, // set locale messages
});

const app = createApp({
  components: { DownloadList },
  mounted() {
    // @ts-ignore
    window.ipcRenderer.on('setPreference', (event: Event, data: {
      displayLanguage: string,
    }) => {
      if (data && data.displayLanguage) {
        this.$i18n.locale = data.displayLanguage;
      }
    });
  },
  template: '<DownloadList/>',
});
installRendererGlobals(app);
app.use(i18n);
app.use(store);
hookVue(app);
app.mount('#app');
