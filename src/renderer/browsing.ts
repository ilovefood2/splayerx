import { createApp } from 'vue';
import { installRendererGlobals } from '@/bootstrap';
// @ts-ignore
import BrowsingPip from '@/components/BrowsingPip.vue';
import '@/css/style.scss';

const app = createApp({
  components: { BrowsingPip },
  template: '<BrowsingPip/>',
});
installRendererGlobals(app);
app.mount('#app');
