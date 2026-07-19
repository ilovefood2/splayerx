import { createStore } from 'vuex';

import modules from './modules';

const store = createStore({
  modules: modules as any, // eslint-disable-line
  strict: process.env.NODE_ENV !== 'production',
});
export default <StoreEx>store;
