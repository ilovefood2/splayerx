import { createApp } from 'vue';
import { mapActions, mapGetters } from 'vuex';
import { createRouter, createWebHashHistory } from 'vue-router';
import { createI18n } from 'vue-i18n';
import electron, { ipcRenderer, remote } from 'electron';
import osLocale from 'os-locale';
import { hookVue } from '@/kerning';
import { installRendererGlobals } from '@/bootstrap';
import messages from '@/locales';
import store from '@/store';
import Preference from '@/components/Preference.vue';
import {
  UserInfo as uActions,
} from '@/store/actionTypes';
import '@/css/style.scss';
import {
  getUserInfo, getProductList, setToken, getGeoIP, getUserBalance,
} from '@/libs/apis';
import drag from '@/helpers/drag';

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

const routeMap = {
  general: 'General',
  privacy: 'Privacy',
  translate: 'Translate',
  account: 'Account',
  premium: 'Premium',
  points: 'Points',
  video: 'Video',
};

const routes = [
  {
    path: '/',
    name: 'General',
    component: require('@/components/Preferences/General.vue').default,
  },
  {
    path: '/privacy',
    name: 'Privacy',
    component: require('@/components/Preferences/Privacy.vue').default,
  },
  {
    path: '/translate',
    name: 'Translate',
    component: require('@/components/Preferences/Translate.vue').default,
  },
  {
    path: '/account',
    name: 'Account',
    component: require('@/components/Preferences/Account.vue').default,
  },
  {
    path: '/premium',
    name: 'Premium',
    component: require('@/components/Preferences/Premium.vue').default,
  },
  {
    path: '/points',
    name: 'Points',
    component: require('@/components/Preferences/Points.vue').default,
  },
  {
    path: '/video',
    name: 'Video',
    component: require('@/components/Preferences/Video.vue').default,
  },
  {
    path: '/whatsnew',
    name: 'Whatsnew',
    component: require('@/components/Preferences/Whatsnew.vue').default,
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/',
  },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

const i18n = createI18n({
  legacy: true,
  locale: getSystemLocale(), // set locale
  fallbackLocale: 'en',
  messages, // set locale messages
});

const app = createApp({
  components: { Preference },
  data() {
    return {
      didGetUserInfo: false,
      didGetUserBalance: false,
    };
  },
  computed: {
    ...mapGetters([
      'signInCallback',
    ]),
  },
  async mounted() {
    drag(this.$el);
    this.$store.commit('getLocalPreference');
    ipcRenderer.on('clear-signIn-callback', () => {
      this.removeCallback(() => { });
    });
    // sign in success
    ipcRenderer.on('sign-in', (e, account) => {
      this.updateUserInfo(account);
      if (account) {
        setToken(account.token);
        this.updateToken(account.token);
        this.getUserInfo();
        this.getUserBalance();
        // sign in success, callback
        if (this.signInCallback) {
          this.signInCallback();
          this.removeCallback(() => { });
        }
      } else {
        setToken('');
        this.updateToken('');
        this.didGetUserInfo = false;
        this.didGetUserBalance = false;
      }
    });

    ipcRenderer.on('route-change', (e, route) => {
      route = route || 'account';
      const currentRoute = this.$router.currentRoute.value;
      if (currentRoute && currentRoute.name === routeMap[route]) return;
      if (routeMap[route]) {
        this.$router.push({ name: routeMap[route] });
      }
    });

    // load global data when sign in is opend
    const account = remote.getGlobal('account');
    this.updateUserInfo(account);
    if (account && account.token) {
      this.updateToken(account.token);
      setToken(account.token);
      this.getUserInfo();
      this.getUserBalance();
    }

    getGeoIP().then((res) => {
      this.$store.dispatch('updateGeo', res);
    }).catch(() => {
      // empty
    });
    // get products
    try {
      const productList = await getProductList();
      this.updatePremiumList(productList);
    } catch (error) {
      // empty
    }
  },
  methods: {
    ...mapActions({
      updateUserInfo: uActions.UPDATE_USER_INFO,
      updateToken: uActions.UPDATE_USER_TOKEN,
      updatePremiumList: uActions.UPDATE_PREMIUM,
      removeCallback: uActions.UPDATE_SIGN_IN_CALLBACK,
    }),
    async getUserInfo() {
      if (this.didGetUserInfo) return;
      this.didGetUserInfo = true;
      try {
        const res = await getUserInfo();
        this.updateUserInfo(res.me);
      } catch (error) {
        // empty
        this.didGetUserInfo = false;
      }
    },
    async getUserBalance() {
      if (this.didGetUserBalance) return;
      this.didGetUserBalance = true;
      try {
        const res = await getUserBalance();
        if (res.translation && res.translation.balance) {
          this.updateUserInfo({
            points: res.translation.balance,
          });
        }
      } catch (error) {
        // empty
        this.didGetUserBalance = false;
      }
    },
  },
  template: '<Preference/>',
});
installRendererGlobals(app);
app.use(i18n);
app.use(router);
app.use(store);
hookVue(app);
app.mount('#app');
