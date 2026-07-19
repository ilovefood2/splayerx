import { createStore } from 'vuex';

const modules = {
  UserInfo: require('@/store/modules/UserInfo').default,
};

export default createStore({
  modules,
  strict: process.env.NODE_ENV !== 'production',
});
