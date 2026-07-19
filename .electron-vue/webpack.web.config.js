'use strict';

process.env.BABEL_ENV = 'renderer';

const path = require('path');
const childProcess = require('child_process');
const webpack = require('webpack');
const { VueLoaderPlugin } = require('vue-loader');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
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
    template: path.resolve(__dirname, `../src/web.ejs`),
    minify: {
      collapseWhitespace: true,
      removeAttributeQuotes: true,
      removeComments: true,
    },
    nodeModules:
      process.env.NODE_ENV !== 'production' ? path.resolve(__dirname, '../node_modules') : false,
  };
}

/**
 * List of node_modules to include in webpack bundle
 *
 * Required for specific packages like Vue UI libraries
 * that provide pure *.vue files that need compiling
 * https://simulatedgreg.gitbooks.io/electron-vue/content/en/webpack-configurations.html#white-listing-externals
 */
let whiteListedModules = ['vue', 'vuex', 'vue-router', 'vue-i18n', 'configcat-js', '@sentry/vue'];

const entry = {
  login: path.join(__dirname, '../src/renderer/login.ts'),
  premium: path.join(__dirname, '../src/renderer/premium.ts'),
};
if (process.env.NODE_ENV !== 'production') {
  entry['index'] = entry['login'];
}

let webConfig = {
  mode: 'development',
  devtool: 'eval-source-map',
  entry,
  externals: [
    ...Object.keys(Object.assign({}, dependencies, optionalDependencies)).filter(
      d => !whiteListedModules.includes(d),
    ),
    'electron',
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
        test: /\.js$/,
        include: [
          path.resolve(__dirname, '../node_modules/@sentry'),
        ],
        use: 'babel-loader',
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
    new HtmlWebpackPlugin(generateHtmlWebpackPluginConfig('login')),
    new HtmlWebpackPlugin(generateHtmlWebpackPluginConfig('premium')),
    new webpack.HotModuleReplacementPlugin(),
  ],
  output: {
    clean: true,
    publicPath: process.env.NODE_ENV !== 'production' ? undefined : process.env.WEB_CDN,
    filename: '[name].[fullhash].js',
    chunkFilename: 'chunks/[contenthash].js',
    libraryTarget: 'umd',
    path: path.join(__dirname, '../dist/web'),
    globalObject: 'this',
  },
  resolve: {
    alias: {
      '@': path.join(__dirname, '../src/renderer'),
      vue$: '@vue/compat/dist/vue.esm-bundler.js',
      grpc: '@grpc/grpc-js',
    },
    extensions: ['.web.ts', '.web.js', '.ts', '.tsx', '.js', '.json'],
    fallback: {
      fs: false,
      path: require.resolve('path-browserify'),
      querystring: require.resolve('querystring-es3'),
    },
  },
  target: 'web',
};

const sharedDefinedVariables = {
  __VUE_OPTIONS_API__: 'true',
  __VUE_PROD_DEVTOOLS__: 'false',
  __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
};

/**
 * Adjust webConfig for development settings
 */
if (process.env.NODE_ENV !== 'production') {
  webConfig.plugins.push(
    new webpack.DefinePlugin(
      Object.assign(sharedDefinedVariables, {
        'process.env.SAGI_API': `"${process.env.SAGI_API || 'apis.stage.sagittarius.ai:8443'}"`,
        'process.env.ACCOUNT_API': `"${process.env.ACCOUNT_API ||
          'https://account.stage.splayer.org'}"`,
        'process.env.ACCOUNT_SITE': `"${process.env.ACCOUNT_SITE ||
          'https://account.stage.splayer.org'}"`,
        __static: `"${path.join(__dirname, '../static').replace(/\\/g, '\\\\')}"`,
      }),
    ),
  );
} else {
  webConfig.plugins.push(
    new webpack.optimize.MinChunkSizePlugin({
      minChunkSize: 100000,
    }),
  );
}

/**
 * Adjust webConfig for production settings
 */
if (process.env.NODE_ENV === 'production') {
  webConfig.mode = 'production';
  webConfig.devtool = 'source-map';

  webConfig.plugins.push(
    new MiniCssExtractPlugin({ filename: '[name].css', chunkFilename: 'chunks/[id].css' }),
    new webpack.DefinePlugin(
      Object.assign(sharedDefinedVariables, {
        'process.env.SAGI_API': `"${process.env.SAGI_API || 'apis.sagittarius.ai:8443'}"`,
        'process.env.ACCOUNT_API': `"${process.env.ACCOUNT_API || 'https://account.splayer.org'}"`,
        'process.env.ACCOUNT_SITE': `"${process.env.ACCOUNT_SITE || 'https://account.splayer.org'}"`,
        'process.env.SENTRY_RELEASE': `"${release}"`,
        'process.env.NODE_ENV': '"production"',
      }),
    ),
  );

  webConfig.optimization = {
    minimizer: [
      new TerserPlugin({
        terserOptions: {
          keep_classnames: true,
        },
      }),
    ],
    splitChunks: {
      cacheGroups: {
        commons: {
          name: 'commons',
          chunks: 'initial',
          minChunks: 2,
        },
      },
    },
  };

}

module.exports = webConfig;
