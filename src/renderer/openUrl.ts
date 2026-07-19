import { createApp } from 'vue';
import { createI18n } from 'vue-i18n';
import { hookVue } from '@/kerning';
import { installRendererGlobals } from '@/bootstrap';
import messages from '@/locales';
// @ts-ignore
import OpenUrl from '@/containers/OpenUrl.vue';
import '@/css/style.scss';

const i18n = createI18n({
  legacy: true,
  // @ts-ignore
  locale: window.displayLanguage, // set locale
  fallbackLocale: 'en',
  messages, // set locale messages
});

const app = createApp({
  components: { OpenUrl },
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
  template: '<OpenUrl/>',
});
installRendererGlobals(app);
app.use(i18n);
hookVue(app);
app.mount('#app');
