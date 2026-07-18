const fs = require('fs');
const path = require('path');
const mediaBinaries = require('ffmpeg-ffprobe-static');
const { videos, audios, subtitles } = require('../config/fileAssociations');

function generateFileAssociations(platform) {
  const fileAssociations = [];
  const iconExt = platform === 'mac' ? 'icns' : 'ico';
  const generateItem = (name, ext, icon) => ({
    name,
    ext,
    role: 'Viewer',
    icon: `build/icons/${icon}.${iconExt}`,
  });
  const checkIcon = (ext) => {
    const iconPath = `build/icons/${ext}.${iconExt}`;
    const iconAbsPath = path.join(__dirname, `../${iconPath}`);
    if (fs.existsSync(iconAbsPath)) {
      return generateItem(ext.toUpperCase(), [ext], ext);
    }
    return null;
  };
  [
    { name: 'Video', exts: videos },
    { name: 'Audio', exts: audios },
    { name: 'Subtitle', exts: subtitles },
  ].forEach(({ name, exts }) => {
    const others = generateItem(name, [], 'others');
    exts.forEach((ext) => {
      const item = checkIcon(ext);
      if (item) {
        fileAssociations.push(item);
      } else {
        others.ext.push(ext);
      }
    });
    if (others.ext.length) fileAssociations.push(others);
  });
  return fileAssociations;
}

const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../package.json'), 'utf-8'),
);
const electronVersion = packageJson.devDependencies.electron.split('-')[0];
const win = {
  icon: 'build/icons/icon.ico',
  fileAssociations: generateFileAssociations('win'),
};
const mac = {
  category: 'public.app-category.entertainment',
  target: 'dmg',
  hardenedRuntime: true,
  asarUnpack: ['node_modules/**/*.node'],
  icon: 'icons/icon.icns',
  fileAssociations: generateFileAssociations('mac'),
};

const config = {
  appId: 'org.splayer.splayerx',
  productName: 'SPlayer',
  publish: [
    {
      provider: 'github',
      owner: 'chiflix',
      repo: 'splayerx',
    },
  ],
  afterSign: 'scripts/notarize.js',
  afterPack: 'scripts/after-pack.js',
  compression: 'maximum',
  directories: {
    output: 'build',
  },
  electronVersion,
  electronDist: 'node_modules/electron/dist',
  files: ['dist/electron/**/*'],
  extraResources: [
    {
      from: 'node_modules/regedit/vbs',
      to: 'regedit/vbs',
      filter: ['**/*'],
    },
    {
      from: mediaBinaries.ffmpegPath,
      to: 'bin/ffmpeg',
    },
    {
      from: mediaBinaries.ffprobePath,
      to: 'bin/ffprobe',
    },
    // Self-contained whisper.cpp (whisper-cli + dylibs + backend .so files) so
    // speech-to-subtitle works with nothing installed. Built by
    // scripts/bundle-whisper.sh on macOS; the entry is added below only when it
    // exists, so Windows/Linux builds — which have no bundle — don't fail.
  ],
  win,
  mac,
  appx: {
    identityName: '29951SHENGSHEN.SPlayer4',
    applicationId: 'SPlayer',
    backgroundColor: '#FF7A1C',
    displayName: 'SPlayer - One Browser for All Media',
    publisher: 'CN=840E2570-B48E-4F56-A2DA-0D9720F91080',
    publisherDisplayName: 'SHENG SHEN',
    languages: ['en', 'ar', 'es', 'ja', 'ko', 'zh-Hans', 'zh-Hant'],
  },
  dmg: {
    background: 'build/icons/dmg/bg.tiff',
    icon: 'build/icons/dmg/install.icns',
    iconSize: 95,
    window: {
      width: 540,
      height: 320,
    },
    contents: [
      {
        x: 400,
        y: 148,
        type: 'link',
        path: '/Applications',
      },
      {
        x: 131,
        y: 150,
        type: 'file',
      },
    ],
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
  },
};

const whisperBundleDir = path.join(__dirname, '../build/whisper');
if (fs.existsSync(path.join(whisperBundleDir, 'whisper-cli'))) {
  config.extraResources.push({
    from: 'build/whisper',
    to: 'whisper',
    filter: ['**/*'],
  });
} else {
  // eslint-disable-next-line no-console
  console.warn(
    'gen-electron-builder-config: build/whisper not found — '
    + 'run scripts/bundle-whisper.sh to bundle speech recognition.',
  );
}

const llamaBundleDir = path.join(__dirname, '../build/llama');
if (fs.existsSync(path.join(llamaBundleDir, 'llama-server'))) {
  config.extraResources.push({
    from: 'build/llama',
    to: 'llama',
    filter: ['**/*'],
  });
} else {
  // eslint-disable-next-line no-console
  console.warn(
    'gen-electron-builder-config: build/llama not found — '
    + 'run scripts/bundle-llama.sh to bundle Qwen3 inference.',
  );
}

const json = JSON.stringify(config, null, 2);
fs.writeFileSync(path.join(__dirname, '../electron-builder.json'), json, {
  encoding: 'utf-8',
});
