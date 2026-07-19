'use strict';

process.env.BABEL_ENV = 'renderer';

const path = require('path');
const childProcess = require('child_process');
const webpack = require('webpack');
const { VueLoaderPlugin } = require('vue-loader');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const { sentryWebpackPlugin } = require('@sentry/webpack-plugin');
const TerserPlugin = require('terser-webpack-plugin');
const { dependencies, optionalDependencies } = require('../package.json');

let release = '';
try {
  const result = childProcess.spawnSync('git', [
    'describe',
    '--tag',
    '--exact-match',
    '--abbrev=0',
  ]);
  if (result.status === 0) {
    const tag = result.stdout.toString('utf8').replace(/^\s+|\s+$/g, '');
    if (tag) release = `SPlayer${tag}`;
  }
} catch (ex) {
  console.error(ex);
}

function generateHtmlWebpackPluginConfig(name) {
  return {
    chunks: [name],
    filename: `${name}.html`,
    template: path.resolve(__dirname, `../src/index.ejs`),
    minify: {
      collapseWhitespace: true,
      removeAttributeQuotes: true,
      removeComments: true,
    },
    nodeModules:
      process.env.NODE_ENV !== 'production' ? path.resolve(__dirname, '../node_modules') : false,
  };
}

const electronCompat = path.join(__dirname, '../src/renderer/electronCompat.js');

/**
 * List of node_modules to include in webpack bundle
 *
 * Required for specific packages like Vue UI libraries
 * that provide pure *.vue files that need compiling
 * https://simulatedgreg.gitbooks.io/electron-vue/content/en/webpack-configurations.html#white-listing-externals
 */
// Vue-coupled packages must share the bundled @vue/compat runtime. Externalizing
// them makes Node load a second, plain Vue runtime and breaks injection/rendering.
let whiteListedModules = [
  '@sentry/vue',
  '@vue/compat',
  'vue',
  'vue-i18n',
  'vue-router',
  'vuex',
];

let rendererConfig = {
  mode: 'development',
  devtool: 'eval-source-map',
  entry: {
    preference: [electronCompat, path.join(__dirname, '../src/renderer/preference.js')],
    about: [electronCompat, path.join(__dirname, '../src/renderer/about.js')],
    losslessStreaming: [electronCompat, path.join(__dirname, '../src/renderer/losslessStreaming.js')],
    payment: [electronCompat, path.join(__dirname, '../src/renderer/payment.ts')],
    index: [electronCompat, path.join(__dirname, '../src/renderer/main.ts')],
    browsing: [electronCompat, path.join(__dirname, '../src/renderer/browsing.ts')],
    openUrl: [electronCompat, path.join(__dirname, '../src/renderer/openUrl.ts')],
    download: [electronCompat, path.join(__dirname, '../src/renderer/download.ts')],
    downloadList: [electronCompat, path.join(__dirname, '../static/download/downloadList.ts')],
  },
  externals: [
    ...Object.keys(Object.assign({}, dependencies, optionalDependencies)).filter(
      d => !whiteListedModules.includes(d),
    ),
    '@sentry/electron/renderer',
  ],
  module: {
    rules: [
      {
        test: /\.css$/,
        use: [
          process.env.NODE_ENV === 'production' ? MiniCssExtractPlugin.loader : 'style-loader',
          'css-loader',
        ],
      },
      {
        test: /\.html$/,
        exclude: /\.vue\.html$/,
        type: 'asset/source',
      },
      {
        test: /\.py$/,
        type: 'asset/source',
      },
      {
        test: /\.tsx?$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader',
            options: {
              transpileOnly: true,
              appendTsSuffixTo: [/\.vue$/],
            },
          },
        ],
      },
      {
        test: /\.js$/,
        use: 'babel-loader',
        exclude: /node_modules/,
      },
      {
        test: /\.vue$/,
        loader: 'vue-loader',
      },
      {
        test: /\.sass$/,
        use: [
          process.env.NODE_ENV === 'production'
            ? MiniCssExtractPlugin.loader
            : 'vue-style-loader',
          'css-loader',
          { loader: 'sass-loader', options: { sassOptions: { indentedSyntax: true } } },
          {
            loader: 'sass-resources-loader',
            options: { resources: path.join(__dirname, '../src/renderer/css/global.scss') },
          },
        ],
      },
      {
        test: /\.scss$/,
        use: [
          process.env.NODE_ENV === 'production'
            ? MiniCssExtractPlugin.loader
            : 'vue-style-loader',
          'css-loader',
          'sass-loader',
          {
            loader: 'sass-resources-loader',
            options: { resources: path.join(__dirname, '../src/renderer/css/global.scss') },
          },
        ],
      },
      {
        test: /\.svg$/,
        include: [path.resolve(__dirname, '../src/renderer/assets/icon')],
        use: [
          {
            loader: 'svg-sprite-loader',
            options: {
              symbolId: '[name]',
            },
          },
        ],
      },
      {
        test: /\.(png|jpe?g|gif|svg)(\?.*)?$/,
        exclude: [path.resolve(__dirname, '../src/renderer/assets/icon')],
        type: 'asset',
        parser: {
          dataUrlCondition: {
            maxSize: 10000,
          },
        },
        generator: {
          filename: 'imgs/[name].[contenthash][ext]',
        },
      },
      {
        test: /\.(mp4|webm|ogg|mp3|wav|flac|aac)(\?.*)?$/,
        type: 'asset',
        parser: {
          dataUrlCondition: {
            maxSize: 10000,
          },
        },
        generator: {
          filename: 'media/[name].[contenthash][ext]',
        },
      },
      {
        test: /\.(woff2?|eot|ttf|ttc|otf)(\?.*)?$/,
        type: 'asset',
        parser: {
          dataUrlCondition: {
            maxSize: 10000,
          },
        },
        generator: {
          filename: 'fonts/[name].[contenthash][ext]',
        },
      },
    ],
  },
  node: false,
  plugins: [
    new VueLoaderPlugin(),
    new HtmlWebpackPlugin(generateHtmlWebpackPluginConfig('index')),
    new HtmlWebpackPlugin(generateHtmlWebpackPluginConfig('about')),
    new HtmlWebpackPlugin(generateHtmlWebpackPluginConfig('losslessStreaming')),
    new HtmlWebpackPlugin(generateHtmlWebpackPluginConfig('payment')),
    new HtmlWebpackPlugin(generateHtmlWebpackPluginConfig('preference')),
    new HtmlWebpackPlugin(generateHtmlWebpackPluginConfig('browsing')),
    new HtmlWebpackPlugin(generateHtmlWebpackPluginConfig('openUrl')),
    new HtmlWebpackPlugin(generateHtmlWebpackPluginConfig('download')),
    new HtmlWebpackPlugin(generateHtmlWebpackPluginConfig('downloadList')),
    new webpack.HotModuleReplacementPlugin(),
  ],
  output: {
    filename: '[name].js',
    libraryTarget: 'commonjs2',
    path: path.join(__dirname, '../dist/electron'),
    globalObject: 'this',
  },
  resolve: {
    alias: {
      '@': path.join(__dirname, '../src/renderer'),
      vue$: '@vue/compat/dist/vue.esm-bundler.js',
      electron: 'electron',
      grpc: '@grpc/grpc-js',
    },
    extensions: ['.ts', '.tsx', '.js', '.json', '.node'],
  },
  target: 'electron-renderer',
};

const sharedDefinedVariables = {
  'process.platform': `"${process.platform}"`,
  __VUE_OPTIONS_API__: 'true',
  __VUE_PROD_DEVTOOLS__: 'false',
  __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
};

if (process.env.ENVIRONMENT_NAME === 'APPX') {
  // quick fix for process.windowsStore undefined on Windows Store build
  sharedDefinedVariables['process.windowsStore'] = 'true';
}
/**
 * Adjust rendererConfig for development settings
 */
if (process.env.NODE_ENV !== 'production') {
  rendererConfig.plugins.push(
    new webpack.DefinePlugin(
      Object.assign(sharedDefinedVariables, {
        'process.env.SAGI_API': `"${process.env.SAGI_API || 'apis.stage.sagittarius.ai:8443'}"`,
        'process.env.ACCOUNT_API': `"${process.env.ACCOUNT_API ||
          'http://stage.account.splayer.work'}"`,
        'process.env.ACCOUNT_SITE': `"${process.env.ACCOUNT_SITE ||
          'http://stage.account.splayer.work'}"`,
        __static: `"${path.join(__dirname, '../static').replace(/\\/g, '\\\\')}"`,
      }),
    ),
  );
}

/**
 * Adjust rendererConfig for production settings
 */
if (process.env.NODE_ENV === 'production') {
  rendererConfig.mode = 'production';
  rendererConfig.devtool = 'source-map';

  rendererConfig.plugins.push(
    new MiniCssExtractPlugin({ filename: '[name].css', chunkFilename: 'chunks/[id].css' }),
    new CopyWebpackPlugin({
      patterns: [
        {
          from: path.join(__dirname, '../static'),
          to: path.join(__dirname, '../dist/electron/static'),
          globOptions: { ignore: ['**/.*'] },
        },
      ],
    }),
    new webpack.DefinePlugin(
      Object.assign(sharedDefinedVariables, {
        'process.env.SAGI_API': `"${process.env.SAGI_API || 'apis.sagittarius.ai:8443'}"`,
        'process.env.ACCOUNT_API': `"${process.env.ACCOUNT_API || 'https://account.splayer.work'}"`,
        'process.env.ACCOUNT_SITE': `"${process.env.ACCOUNT_SITE || 'https://account.splayer.work'}"`,
        'process.env.SENTRY_RELEASE': `"${release}"`,
        'process.env.NODE_ENV': '"production"',
      }),
    ),
  );

  rendererConfig.optimization = {
    minimizer: [
      new TerserPlugin({
        terserOptions: {
          keep_classnames: true,
        },
      }),
    ],
  };

  if (
    release &&
    process.env.SENTRY_AUTH_TOKEN &&
    process.env.SENTRY_ORG &&
    process.env.SENTRY_PROJECT
  ) {
    rendererConfig.plugins.push(
      sentryWebpackPlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        release: { name: release },
        sourcemaps: {
          assets: ['./dist/electron/**/*.js', './dist/electron/**/*.map'],
          ignore: ['./dist/electron/static/**'],
        },
      }),
    );
  }
}

module.exports = rendererConfig;
