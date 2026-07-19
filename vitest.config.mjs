import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [
    vue({
      template: {
        compilerOptions: {
          compatConfig: { MODE: 2 },
        },
      },
    }),
  ],
  define: {
    __static: JSON.stringify(fileURLToPath(new URL('./static', import.meta.url))),
    __VUE_OPTIONS_API__: 'true',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
  },
  resolve: {
    alias: [
      {
        find: /^@\/store$/,
        replacement: fileURLToPath(new URL('./test/unit/mocks/store.js', import.meta.url)),
      },
      {
        find: '@',
        replacement: fileURLToPath(new URL('./src/renderer', import.meta.url)),
      },
      {
        find: 'electron',
        replacement: fileURLToPath(new URL('./test/unit/mocks/electron.cjs', import.meta.url)),
      },
      { find: 'grpc', replacement: '@grpc/grpc-js' },
    ],
  },
  css: {
    preprocessorOptions: {
      sass: { additionalData: '@use "@/css/global.scss" as *\n' },
      scss: { additionalData: '@use "@/css/global.scss" as *;\n' },
    },
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    fileParallelism: false,
    setupFiles: ['./test/unit/setup.js'],
    include: ['./test/unit/specs/**/*.spec.js'],
    deps: {
      optimizer: {
        client: {
          enabled: true,
          include: ['@vue/test-utils', 'vue-i18n', 'vuex'],
        },
      },
    },
    testTimeout: 10000,
    hookTimeout: 10000,
    restoreMocks: false,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/renderer/**/*.{js,ts,vue}', 'src/shared/**/*.{js,ts}'],
      exclude: [
        'src/renderer/**/*.d.ts',
        'src/renderer/electronCompat.js',
        'src/renderer/{about,browsing,download,login,losslessStreaming,main,openUrl,payment,preference}.+(js|ts)',
      ],
    },
  },
});
