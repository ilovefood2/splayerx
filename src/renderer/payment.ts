import { createApp } from 'vue';
import { ipcRenderer, remote } from 'electron';
import { createI18n } from 'vue-i18n';
import osLocale from 'os-locale';
import messages from '@/locales';
import { hookVue } from '@/kerning';
import { installRendererGlobals } from '@/bootstrap';
import { setToken } from '@/libs/apis';
// @ts-ignore
import Payment from '@/components/Payment.vue';
import '@/css/style.scss';

function getSystemLocale() {
  const { app } = remote;
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
  components: { Payment },
  mounted() {
    // sign in success
    ipcRenderer.on('sign-in', (e: Event, account?: {
      token: string, id: string,
    }) => {
      if (account) {
        setToken(account.token);
      } else {
        setToken('');
      }
    });

    // load global data when sign in is opend
    const account = remote.getGlobal('account');
    if (account && account.token) {
      setToken(account.token);
    }
  },
  template: '<Payment/>',
});
installRendererGlobals(app);
app.use(i18n);
hookVue(app);
app.mount('#app');
