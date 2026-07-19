module.exports = function babelConfig(api) {
  const environment = api.env();

  return {
    comments: false,
    plugins: [],
    presets: [
      [
        '@babel/preset-env',
        {
          bugfixes: true,
          modules: false,
          targets: { electron: '43' },
        },
      ],
    ],
  };
};
