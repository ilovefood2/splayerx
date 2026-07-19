import * as Sentry from '@sentry/vue';
import { createApp } from 'vue';
import { createRouter, createWebHashHistory } from 'vue-router';
import { createI18n } from 'vue-i18n';
import { hookVue } from '@/kerning';
import messages from '@/locales';
// @ts-ignore
import Login from '@/containers/Login/Login.vue';
import '@/css/style.scss';
import { getSystemLocale } from '@/../shared/utils';

let logSave = (_error?: object) => undefined;
if (Sentry) {
  logSave = (error: object = {}) => {
    Sentry.withScope((scope: any) => { // eslint-disable-line
      Object.keys(error).forEach((key: string) => {
        scope.setExtra(key, error[key]);
      });
      Sentry.captureMessage('server-call-error');
    });
  };
}
const routes = [
  {
    path: '/sms',
    name: 'sms',
    component: require('@/containers/Login/SMS.vue').default,
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/sms',
  },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

const i18n = createI18n({
  legacy: true,
  // @ts-ignore
  locale: window.displayLanguage || getSystemLocale(), // set locale
  fallbackLocale: 'en',
  messages, // set locale messages
});

const app = createApp({
  components: { Login },
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
  template: '<Login/>',
});
app.config.globalProperties.logSave = logSave;
app.use(i18n);
app.use(router);
hookVue(app);
if (process.env.NODE_ENV !== 'development') {
  Sentry.init({
    app,
    dsn: 'https://6a94feb674b54686a6d88d7278727b7c@sentry.io/1449341',
    attachProps: true,
  });
}
app.mount('#app');
