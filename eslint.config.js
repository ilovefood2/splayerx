const js = require('@eslint/js');
const typescriptParser = require('@typescript-eslint/parser');
const typescriptPlugin = require('@typescript-eslint/eslint-plugin');
const importPlugin = require('eslint-plugin-import');
const vueParser = require('vue-eslint-parser');
const vuePlugin = require('eslint-plugin-vue');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      'coverage/**',
      'dist/**',
      'node_modules/**',
      'test/unit/coverage/**',
      'test/assets/**',
      'test/e2e/**',
    ],
  },
  {
    files: ['**/*.{js,ts,vue}'],
    linterOptions: {
      reportUnusedDisableDirectives: false,
    },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        __static: 'readonly',
      },
      parser: vueParser,
      parserOptions: {
        parser: typescriptParser,
        ecmaFeatures: { jsx: true },
        extraFileExtensions: ['.vue'],
      },
    },
    plugins: {
      '@typescript-eslint': typescriptPlugin,
      import: importPlugin,
      vue: vuePlugin,
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-console': ['error', {
        allow: ['trace', 'warn', 'error', 'time', 'timeEnd'],
      }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-async-promise-executor': 'off',
      // vue-eslint-parser reports Sass @else chains as JavaScript branches.
      'no-dupe-else-if': 'off',
      'no-prototype-builtins': 'off',
      'no-redeclare': 'off',
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'no-useless-escape': 'off',
      '@typescript-eslint/no-explicit-any': ['error', { ignoreRestArgs: true }],
      'import/no-extraneous-dependencies': ['error', { devDependencies: true }],
      // Legacy SFCs contain historical eslint directive comments in template,
      // script and style blocks. Keep semantic Vue checks enabled without
      // interpreting those source comments as template control directives.
      'vue/comment-directive': 'off',
      'vue/no-dupe-keys': 'error',
      'vue/no-parsing-error': 'error',
    },
  },
  {
    files: ['test/**/*.{js,ts,vue}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.mocha,
        ...globals.vitest,
      },
    },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['src/main/**/*.{js,ts}'],
    rules: { 'no-console': 'off' },
  },
];
