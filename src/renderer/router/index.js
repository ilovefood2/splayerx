import { createRouter, createWebHashHistory } from 'vue-router';

export default createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      name: 'landing-view',
      component: () => import('@/containers/LandingView.vue'),
    },
    {
      path: '/play',
      name: 'playing-view',
      component: require('@/components/PlayingView.vue').default,
    },
    {
      path: '/browsing',
      name: 'browsing-view',
      component: () => import('@/components/BrowsingView.vue'),
    },
    {
      path: '/welcome',
      component: () => import('@/components/Welcome/WelcomeView.vue'),
      children: [
        {
          path: '',
          name: 'welcome-privacy',
          component: () => import('@/components/Welcome/WelcomePrivacy.vue'),
        },
        {
          path: 'language',
          name: 'language-setting',
          component: () => import('@/components/Welcome/LanguageSetting.vue'),
        },
      ],
    },
    {
      path: '/:pathMatch(.*)*',
      redirect: '/welcome/language',
    },
  ],
});
