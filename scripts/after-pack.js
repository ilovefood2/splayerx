const fs = require('fs');
const path = require('path');
const { v5, parse } = require('uuid');

// Give macOS Local Network privacy an app-specific identity before code signing.
exports.patchMacExecutableUuid = (file, appId) => {
  if (typeof appId !== 'string' || !appId) throw new Error('Missing app identifier');
  const binary = fs.readFileSync(file);
  // shortcut: packaged arm64/x64 binaries are thin; add fat-header support for universal builds.
  if (binary.length < 32 || binary.readUInt32LE(0) !== 0xfeedfacf) {
    throw new Error('Expected a thin 64-bit Mach-O executable');
  }
  const end = 32 + binary.readUInt32LE(20);
  if (end > binary.length) throw new Error('Truncated Mach-O load commands');
  const count = binary.readUInt32LE(16);
  let position = 32;
  for (let index = 0; index < count; index += 1) {
    if (position + 8 > end) throw new Error('Truncated Mach-O load command');
    const command = binary.readUInt32LE(position);
    const size = binary.readUInt32LE(position + 4);
    if (size < 8 || position + size > end) throw new Error('Invalid Mach-O load command size');
    if (command === 0x1b) {
      if (size !== 24) throw new Error('Invalid Mach-O UUID command');
      const identity = v5(`${appId}:${binary.readUInt32LE(4)}`, v5.DNS);
      Buffer.from(parse(identity)).copy(binary, position + 8);
      fs.writeFileSync(file, binary);
      return identity;
    }
    position += size;
  }
  throw new Error('Mach-O executable has no UUID command');
};

const languages = [
  'am',
  'ar',
  'bg',
  'bn',
  'ca',
  'cs',
  'da',
  'de',
  'el',
  'en-GB',
  'en-US',
  'es-419',
  'es',
  'et',
  'fa',
  'fi',
  'fil',
  'fr',
  'gu',
  'he',
  'hi',
  'hr',
  'hu',
  'id',
  'it',
  'ja',
  'kn',
  'ko',
  'lt',
  'lv',
  'ml',
  'mr',
  'ms',
  'nb',
  'nl',
  'pl',
  'pt-BR',
  'pt-PT',
  'ro',
  'ru',
  'sk',
  'sl',
  'sr',
  'sv',
  'sw',
  'ta',
  'te',
  'th',
  'tr',
  'uk',
  'vi',
  'zh-CN',
  'zh-TW',
];
// locales by https://github.com/electron/electron/pull/363/files

// https://github.com/electron-userland/electron-builder/issues/708
// https://github.com/electron/electron/issues/2484
exports.default = (context) => {
  const APP_NAME = context.packager.appInfo.productFilename;
  const APP_OUT_DIR = context.appOutDir;
  const PLATFORM = context.packager.platform.name;
  if (PLATFORM === 'mac') {
    exports.patchMacExecutableUuid(
      path.join(APP_OUT_DIR, `${APP_NAME}.app`, 'Contents', 'MacOS', APP_NAME),
      context.packager.appInfo.id,
    );
    languages.forEach((item) => {
      fs.writeFile(`${APP_OUT_DIR}/${APP_NAME}.app/Contents/Resources/${item}.lproj`, '', (err) => {
        if (err) throw err;
      });
    });
  }
};
