import './helpers/setUserDataDir';
// Be sure to call Sentry function as early as possible in the main process
import '../shared/sentry-main';

import { app, BrowserWindow, session, Tray, ipcMain, globalShortcut, nativeImage, systemPreferences, WebContentsView, webContents, inAppPurchase, screen, dialog, Notification, shell } from 'electron' // eslint-disable-line
import {
  throttle, debounce, uniq, uniqBy,
} from 'lodash';
import os from 'os';
import path, {
  basename, dirname, extname, join, resolve,
} from 'path';
import fs from 'fs';
import qs from 'querystring';
import { castService } from './helpers/cast/CastService';
import { applePayVerify } from './helpers/ApplePayVerify';
import './helpers/electronPrototypes';
import './helpers/rendererBridge';
import {
  isVideo, isSubtitle,
  saveToken, getEnvironmentName,
  getIP, crossThreadCache, calcCurrentChannel, isAudio,
} from '../shared/utils';
import { mouse } from './helpers/mouse';
import MenuService from './menu/MenuService';
import registerMediaTasks from './helpers/mediaTasksPlugin';
import { WebContentsViewManager } from './helpers/WebContentsViewManager';
import InjectJSManager from '../../src/shared/pip/InjectJSManager';
import Locale from '../shared/common/localize';

import losslessStreamingInstance from './helpers/LosslessStreaming';

// requestSingleInstanceLock is not going to work for mas
// https://github.com/electron-userland/electron-packager/issues/923
if (!process.mas && !app.requestSingleInstanceLock()) {
  app.quit();
}

/**
 * Check for restore mark and delete all user data
 */
const userDataPath = app.getPath('userData');
function removeUserDataExceptLockfiles(directory) {
  fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
    if (entry.name === 'lockfile') return;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      removeUserDataExceptLockfiles(entryPath);
      try {
        fs.rmdirSync(entryPath);
      } catch (error) {
        if (error.code !== 'ENOTEMPTY') throw error;
      }
      return;
    }
    fs.rmSync(entryPath, { force: true });
  });
}

if (fs.existsSync(path.join(userDataPath, 'NEED_TO_RESTORE_MARK'))) {
  try {
    app.clearRecentDocuments();
    const tbdPath = `${userDataPath}-TBD`;
    if (fs.existsSync(tbdPath)) fs.rmSync(tbdPath, { recursive: true, force: true });
    fs.renameSync(userDataPath, tbdPath);
    fs.rm(tbdPath, { recursive: true, force: true }, (err) => {
      if (err) console.error(err);
    });
  } catch (ex) {
    console.error(ex);
    try {
      removeUserDataExceptLockfiles(userDataPath);
      console.log('Successfully removed all user data.');
    } catch (ex) {
      console.error(ex);
    }
  }
}

/**
 * Set `__static` path to static files in production
 * https://simulatedgreg.gitbooks.io/electron-vue/content/en/using-static-assets.html
 */
if (process.env.NODE_ENV !== 'development') {
  global.__static = path.join(__dirname, '/static').replace(/\\/g, '\\\\') // eslint-disable-line
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('--enable-features', 'OverlayScrollbar');

let isGlobal = false;
let sidebar = false;
let welcomeProcessDone = false;
let menuService = null;
let routeName = null;
let mainWindow = null;
const mainWindows = new Set();
let mainProcessEventsRegistered = false;
let aboutWindow = null;
let preferenceWindow = null;
let browsingWindow = null;
let downloadWindow = null;
let lastDownloadDate = 0;
let paymentWindow = null;
let openUrlWindow = null;
let losslessStreamingWindow = null;
let webContentsViewManager = null;
let pipControlView = null;
let titlebarView = null;
let downloadListView = null;
let premiumView = null;
let maskView = null;
let maskEventTimer = 0;
let maskDisappearTimer = 0;
let manualAbort = false;
let isBrowsingWindowMax = false;
let availableChannels = [];
let tray = null;
let pipTimer = 0;
let needToRestore = false;
let isVip = true; // set no limits
let hideBrowsingWindow = false;
let signInEndpoint = '';
let signInSite = '';
let applePayProductID = '';
let applePayCurrency = '';
let paymentWindowCloseTag = false;
let applePayVerifyLock = false;
let paymentOrigin = '';
const environmentName = getEnvironmentName();
const locale = new Locale();
const tmpVideoToOpen = [];
const tmpSubsToOpen = [];
const titlebarUrl = process.platform === 'darwin' ? `file:${resolve(__static, 'pip/macTitlebar.html')}` : `file:${resolve(__static, 'pip/winTitlebar.html')}`;
const maskUrl = process.platform === 'darwin' ? `file:${resolve(__static, 'pip/mask.html')}` : `file:${resolve(__static, 'pip/mask.html')}`;
const mainURL = process.env.NODE_ENV === 'development'
  ? 'http://localhost:9080'
  : `file://${__dirname}/index.html`;
const aboutURL = process.env.NODE_ENV === 'development'
  ? 'http://localhost:9080/about.html'
  : `file://${__dirname}/about.html`;
const paymentURL = process.env.NODE_ENV === 'development'
  ? 'http://localhost:9080/payment.html'
  : `file://${__dirname}/payment.html`;
const preferenceURL = process.env.NODE_ENV === 'development'
  ? 'http://localhost:9080/preference.html'
  : `file://${__dirname}/preference.html`;
const openUrlWindowURL = process.env.NODE_ENV === 'development'
  ? 'http://localhost:9080/openUrl.html'
  : `file://${__dirname}/openUrl.html`;
let loginURL = process.env.NODE_ENV === 'development'
  ? 'http://localhost:9081/login.html'
  : `file://${__dirname}/login.html`;
const browsingURL = process.env.NODE_ENV === 'development'
  ? 'http://localhost:9080/browsing.html'
  : `file://${__dirname}/browsing.html`;
const downloadURL = process.env.NODE_ENV === 'development'
  ? 'http://localhost:9080/download.html'
  : `file://${__dirname}/download.html`;
const downloadListURL = process.env.NODE_ENV === 'development'
  ? 'http://localhost:9080/downloadList.html'
  : `file://${__dirname}/downloadList.html`;
let premiumURL = process.env.NODE_ENV === 'development'
  ? 'http://localhost:9081/premium.html'
  : `file://${__dirname}/premium.html`;
const losslessStreamingURL = process.env.NODE_ENV === 'development'
  ? 'http://localhost:9080/losslessStreaming.html'
  : `file://${__dirname}/losslessStreaming.html`;

const tempFolderPath = path.join(app.getPath('temp'), 'splayer');
if (!fs.existsSync(tempFolderPath)) fs.mkdirSync(tempFolderPath, { recursive: true });

function isUsableMainWindow(window) {
  return window && mainWindows.has(window) && !window.isDestroyed()
    && !window.webContents.isDestroyed();
}

function getActiveMainWindow() {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (isUsableMainWindow(focusedWindow)) return focusedWindow;
  if (isUsableMainWindow(mainWindow)) return mainWindow;
  return Array.from(mainWindows).reverse().find(isUsableMainWindow) || null;
}

function getSenderMainWindow(sender) {
  const senderWindow = sender && BrowserWindow.fromWebContents(sender);
  return isUsableMainWindow(senderWindow) ? senderWindow : getActiveMainWindow();
}

function setActiveMainWindow(window) {
  if (!isUsableMainWindow(window)) return;
  mainWindow = window;
  menuService?.focusMainWindow(window);
}

function restoreMainWindowMenu(window) {
  if (!isUsableMainWindow(window)) return;
  setActiveMainWindow(window);
  window.webContents.send('restore-window-menu');
}

function broadcastToMainWindows(channel, ...args) {
  mainWindows.forEach((window) => {
    if (isUsableMainWindow(window)) window.webContents.send(channel, ...args);
  });
}

function hackWindowsRightMenu(win) {
  if (win) {
    win.hookWindowMessage(278, () => {
      win.setEnabled(false);
      setTimeout(() => {
        win.setEnabled(true);
      }, 100);
      return true;
    });
  }
}

function handleBossKey() {
  if (!mainWindow || mainWindow.webContents.isDestroyed()) return;
  if (mainWindow.isVisible()) {
    if (process.platform === 'darwin' && mainWindow.isFullScreen()) {
      mainWindow.once('leave-full-screen', handleBossKey);
      mainWindow.setFullScreen(false);
      return;
    }
    mainWindow.webContents.send('mainCommit', 'PAUSED_UPDATE', true);
    mainWindow.webContents.send('mainCommit', 'isHiddenByBossKey', true);
    mainWindow.hide();
    if (process.platform === 'win32') {
      tray = new Tray(nativeImage.createFromDataURL(require('../../build/icons/1024x1024.png')));
      tray.on('click', () => {
        mainWindow.show();
        mainWindow.webContents.send('mainCommit', 'isHiddenByBossKey', false);
        // Destroy tray in its callback may cause app crash
        setTimeout(() => {
          if (!tray) return;
          tray.destroy();
          tray = null;
        }, 10);
      });
    }
  }
}

function pipControlViewTitle(isGlobal) {
  const danmu = locale.$t('browsing.danmu');
  const title = isGlobal ? locale.$t('browsing.exitPip') : locale.$t('browsing.exitPop');
  const pin = locale.$t('browsing.pin');
  pipControlView.webContents
    .executeJavaScript(InjectJSManager.updatePipControlTitle(title, danmu, pin));
}

function createPipControlView() {
  if (pipControlView && !pipControlView.isDestroyed()) pipControlView.destroy();
  pipControlView = new WebContentsView({
    webPreferences: {
      contextIsolation: false,
      sandbox: false,
      preload: `${require('path').resolve(__static, 'pip/preload.js')}`,
    },
  });
  browsingWindow.addWebContentsView(pipControlView);
  pipControlView.webContents.loadURL(`file:${require('path').resolve(__static, 'pip/pipControl.html')}`);
  pipControlView.setBackgroundColor('#00FFFFFF');
  pipControlView.setBounds({
    x: Math.round(browsingWindow.getSize()[0] - 65),
    y: Math.round(browsingWindow.getSize()[1] / 2 - 72),
    width: 50,
    height: 144,
  });
}

function createDownloadListView(title, list, url, isVip, resolution, path) {
  locale.refreshDisplayLanguage();
  if (downloadListView && !downloadListView.isDestroyed()) downloadListView.destroy();
  downloadListView = new WebContentsView({
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      sandbox: false,
      preload: `${require('path').resolve(__static, 'download/preload.js')}`,
    },
  });
  mainWindow.addWebContentsView(downloadListView);
  downloadListView.setBackgroundColor('#00FFFFFF');
  const availableList = list.find(i => i.ext === 'mp4')
    ? list.filter(i => i.acodec !== 'none' && i.vcodec !== 'none').filter(i => i.ext === 'mp4').sort((a, b) => parseInt(a['format_note'], 10) - parseInt(b['format_note'], 10))
    : list.filter(i => i.acodec !== 'none' && i.vcodec !== 'none').sort((a, b) => parseInt(a['format_note'], 10) - parseInt(b['format_note'], 10));
  const hasFormatNote = availableList.findIndex(i => i['format_note']) !== -1;
  const uniqList = uniqBy(availableList, hasFormatNote ? 'format_note' : 'format');
  let commonDefaultIndex = hasFormatNote ? uniqList.findIndex(i => i['format_note'].toLowerCase().includes(resolution)) : 0;
  if (commonDefaultIndex === -1) {
    const index = uniqList.findIndex(i => parseInt(i['format_note'], 10) > 480);
    commonDefaultIndex = index !== -1 ? index - 1 : uniqList.length - 1;
  }
  const vipDefaultIndex = hasFormatNote && uniqList.findIndex(i => i['format_note'].toLowerCase().includes(resolution)) !== -1
    ? uniqList.findIndex(i => i['format_note'].toLowerCase().includes(resolution)) : uniqList.length - 1;
  const unknownList = uniqList.filter(i => !i['format_note']);
  const normalList = uniqList.filter(i => i['format_note']);
  const listInfo = unknownList.concat(normalList).map((i, index) => {
    let selected = index === 0;
    if (normalList.length) {
      selected = isVip ? index === vipDefaultIndex : index === commonDefaultIndex;
    }
    const definition = i['format_note'] ? i['format_note'] : locale.$t('browsing.download.unknownResolution');
    const defaultName = `${title} (${definition}).${i.ext}`;
    const darwinName = (defaultName.startsWith('.') ? defaultName.slice(1) : defaultName).replace(/[:\\]/g, '');
    const name = process.platform === 'darwin' ? darwinName : defaultName.replace(/[\\?<>*|:/]/g, '');
    return {
      definition, name, selected, id: i['format_id'], ext: i.ext,
    };
  });
  downloadListView.webContents.loadURL(downloadListURL).then(() => {
    downloadListView.webContents.send('init-download-list', {
      listInfo, path, url, isVip,
    });
    if (!isVip) {
      const lastTime = new Date(lastDownloadDate);
      const newTime = new Date();
      const lastDate = lastTime.getDate();
      const lastMonth = lastTime.getMonth();
      const lastYear = lastTime.getFullYear();
      const nowDate = newTime.getDate();
      const nowMonth = newTime.getMonth();
      const nowYear = newTime.getFullYear();
      const available = (lastDate !== nowDate || lastMonth !== nowMonth || lastYear !== nowYear)
        && Date.now() > lastDownloadDate;
      if (!available) downloadListView.webContents.send('update-download-state', 'limited');
    }
  });
  downloadListView.setBounds({
    x: sidebar ? 76 : 0,
    y: 40,
    width: sidebar ? mainWindow.getSize()[0] - 76 : mainWindow.getSize()[0],
    height: mainWindow.getSize()[1] - 40,
  });
  mainWindow.setWebContentsViewAutoResize(downloadListView, {
    width: true,
    height: true,
  });
}

function createTitlebarView() {
  if (titlebarView) titlebarView.destroy();
  titlebarView = new WebContentsView({
    webPreferences: {
      contextIsolation: false,
      sandbox: false,
      preload: `${require('path').resolve(__static, 'pip/titlebarPreload.js')}`,
    },
  });
  browsingWindow.addWebContentsView(titlebarView);
  titlebarView.webContents.loadURL(titlebarUrl);
  titlebarView.setBackgroundColor('#00FFFFFF');
  titlebarView.setBounds({
    x: 0, y: 0, width: browsingWindow.getSize()[0], height: 36,
  });
}

function createMaskView() {
  if (maskView) maskView.destroy();
  maskView = new WebContentsView();
  browsingWindow.addWebContentsView(maskView);
  maskView.webContents.loadURL(maskUrl);
  maskView.setBackgroundColor('#00FFFFFF');
  maskView.setBounds({
    x: 0, y: 0, width: browsingWindow.getSize()[0], height: browsingWindow.getSize()[1],
  });
  maskView.webContents.executeJavaScript(`
    document.body.style.backgroundColor = 'rgba(255, 255, 255, 0.18)';
  `);
}

function markNeedToRestore() {
  fs.closeSync(fs.openSync(path.join(app.getPath('userData'), 'NEED_TO_RESTORE_MARK'), 'w'));
}

function searchSubsInDir(dir) {
  const dirFiles = fs.readdirSync(dir);
  return dirFiles
    .filter(subtitleFilename => isSubtitle(subtitleFilename))
    .map(subtitleFilename => (join(dir, subtitleFilename)));
}
function searchForLocalVideo(subSrc) {
  const videoDir = dirname(subSrc);
  const videoBasename = basename(subSrc, extname(subSrc)).toLowerCase();
  const videoFilename = basename(subSrc).toLowerCase();
  const dirFiles = fs.readdirSync(videoDir);
  return dirFiles
    .filter((subtitleFilename) => {
      const lowerCasedName = subtitleFilename.toLowerCase();
      return (
        isVideo(lowerCasedName) // TODO: audio
        && lowerCasedName.slice(0, lowerCasedName.lastIndexOf('.')) === videoBasename
        && lowerCasedName !== videoFilename && !isSubtitle(lowerCasedName)
      );
    })
    .map(subtitleFilename => (join(videoDir, subtitleFilename)));
}
function getAllValidVideo(onlySubtitle, files) {
  try {
    const videoFiles = [];

    for (let i = 0; i < files.length; i += 1) {
      if (fs.statSync(files[i]).isDirectory()) {
        const dirPath = files[i];
        const dirFiles = fs.readdirSync(dirPath).map(file => path.join(dirPath, file));
        files.push(...dirFiles);
      }
    }
    if (!process.mas) {
      files.forEach((tempFilePath) => {
        const baseName = path.basename(tempFilePath);
        if (baseName.startsWith('.') || fs.statSync(tempFilePath).isDirectory()) return;
        if (isSubtitle((tempFilePath))) {
          const tempVideo = searchForLocalVideo(tempFilePath);
          videoFiles.push(...tempVideo);
        } else if (isVideo(tempFilePath) || isAudio(tempFilePath)) {
          videoFiles.push(tempFilePath);
        }
      });
    } else {
      files.forEach((tempFilePath) => {
        const baseName = path.basename(tempFilePath);
        if (baseName.startsWith('.') || fs.statSync(tempFilePath).isDirectory()) return;
        if (isVideo(tempFilePath) || isAudio(tempFilePath)) {
          videoFiles.push(tempFilePath);
        }
      });
    }
    return uniq(videoFiles);
  } catch (ex) {
    return [];
  }
}

function createOpenRequest(videoFiles = [], subtitleFiles = []) {
  const videos = videoFiles.slice();
  const subtitles = subtitleFiles.slice();
  return {
    videoFiles: videos,
    subtitleFiles: subtitles,
    files: getAllValidVideo(!videos.length, videos.concat(subtitles)),
  };
}

function takeQueuedOpenRequest() {
  const request = createOpenRequest(tmpVideoToOpen, tmpSubsToOpen);
  tmpVideoToOpen.splice(0, tmpVideoToOpen.length);
  tmpSubsToOpen.splice(0, tmpSubsToOpen.length);
  return request;
}

function collectOpenPath(file, videoFiles, subtitleFiles) {
  try {
    const isDirectory = fs.statSync(file).isDirectory();
    if (isSubtitle(file) || isDirectory) subtitleFiles.push(file);
    else if (isVideo(file) || isAudio(file)) videoFiles.push(file);
  } catch (ex) {
    // Ignore arguments that are not readable media paths.
  }
}

function sendOpenRequest(window, request, addSubtitlesToCurrent = false) {
  if (!isUsableMainWindow(window) || !request) return;
  const { videoFiles, subtitleFiles, files } = request;
  if (!videoFiles.length && subtitleFiles.length && addSubtitlesToCurrent) {
    const allSubFiles = [];
    subtitleFiles.forEach((file) => {
      if (isSubtitle(file)) allSubFiles.push(file);
      else allSubFiles.push(...searchSubsInDir(file));
    });
    window.webContents.send('add-local-subtitles', allSubFiles);
  } else if (process.mas && !videoFiles.length && subtitleFiles.length && !files.length) {
    window.webContents.send('open-subtitle-in-mas', subtitleFiles[0]);
  } else if (videoFiles.length + subtitleFiles.length > 0) {
    window.webContents.send('open-file', {
      onlySubtitle: !videoFiles.length,
      files,
    });
  }
}

function setBoundsCenterByOriginWindow(origin, win, width, height) {
  const displays = screen.getAllDisplays();
  const list = displays.map(e => ({
    x: e.workArea.x,
    left: Number((e.workArea.x + (e.workArea.width - width) / 2).toFixed(0)),
    top: Number((e.workArea.y + (e.workArea.height - height) / 2).toFixed(0)),
  })).sort((l, r) => l.x - r.x);
  if (origin && win && list.length > 1) {
    try {
      const pos = origin.getPosition();
      const bounds = pos[0] > list[1].x ? {
        x: list[1].left,
        y: list[1].top,
      } : {
        x: list[0].left,
        y: list[0].top,
      };
      win.setBounds(bounds);
    } catch (error) {
      console.log(error);
    }
  }
}

function createOpenUrlWindow() {
  const openUrlWindowOptions = {
    useContentSize: true,
    frame: false,
    titleBarStyle: 'none',
    width: 450,
    height: 206,
    transparent: true,
    resizable: false,
    show: false,
    webPreferences: {
      contextIsolation: false,
      webSecurity: false,
      nodeIntegration: true,
      sandbox: false,
      experimentalFeatures: true,
      preload: `${require('path').resolve(__static, 'openUrl/preload.js')}`,
    },
    acceptFirstMouse: true,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
  };
  if (!openUrlWindow) {
    openUrlWindow = new BrowserWindow(openUrlWindowOptions);
    // 如果播放窗口顶置，打开首选项也顶置
    if (mainWindow && mainWindow.isAlwaysOnTop()) {
      openUrlWindow.setAlwaysOnTop(true);
    }
    openUrlWindow.loadURL(`${openUrlWindowURL}`);
    openUrlWindow.on('closed', () => {
      openUrlWindow = null;
    });
  } else {
    openUrlWindow.focus();
  }
  openUrlWindow.once('ready-to-show', () => {
    openUrlWindow.show();
  });
  openUrlWindow.on('focus', () => {
    menuService?.enableMenu(false);
  });
  if (process.platform === 'win32') {
    hackWindowsRightMenu(openUrlWindow);
  }
  setBoundsCenterByOriginWindow(mainWindow, openUrlWindow, 540, 426);
}

function createPremiumView(e, route) {
  if (!premiumView) {
    premiumView = new WebContentsView({
      webPreferences: {
        contextIsolation: false,
        sandbox: false,
        preload: `${require('path').resolve(__static, 'premium/preload.js')}`,
        webSecurity: false,
      },
    });
    premiumView.setBackgroundColor('#3B3B41');
    preferenceWindow.setWebContentsView(premiumView);
    if (route) premiumView.webContents.loadURL(`${premiumURL}#/${route}`);
    else premiumView.webContents.loadURL(`${premiumURL}`);
    premiumView.webContents.userAgent = `${premiumView.webContents.userAgent.replace(/Electron\S+/i, '')} SPlayerX@2018 Platform/${os.platform()} Release/${os.release()} Version/${app.getVersion()} EnvironmentName/${environmentName}`;
    premiumView.setBounds({
      x: 110,
      y: 0,
      width: preferenceWindow.getSize()[0] - 110,
      height: preferenceWindow.getSize()[1],
    });
    if (process.env.NODE_ENV === 'development') {
      setTimeout(() => { // wait some time to prevent `Object not found` error
        premiumView.webContents.openDevTools();
      }, 1000);
    }
  } else if (premiumView && !premiumView.webContents.isDestroyed()) {
    premiumView.webContents.send('premium-route-change', route);
  }
}

function createPreferenceWindow(e, route) {
  const preferenceWindowOptions = {
    useContentSize: true,
    frame: false,
    titleBarStyle: 'none',
    width: 592,
    height: 468,
    transparent: true,
    resizable: false,
    show: false,
    webPreferences: {
      contextIsolation: false,
      webSecurity: false,
      nodeIntegration: true,
      sandbox: false,
      experimentalFeatures: true,
    },
    acceptFirstMouse: true,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
  };
  if (!preferenceWindow) {
    preferenceWindow = new BrowserWindow(preferenceWindowOptions);
    // 如果播放窗口顶置，打开首选项也顶置
    if (mainWindow && mainWindow.isAlwaysOnTop()) {
      preferenceWindow.setAlwaysOnTop(true);
    }
    if (route) preferenceWindow.loadURL(`${preferenceURL}#/${route}`);
    else preferenceWindow.loadURL(`${preferenceURL}`);
    preferenceWindow.on('closed', () => {
      preferenceWindow = null;
      if (paymentWindow) {
        paymentWindow.close();
      }
    });
    preferenceWindow.webContents.userAgent = `${preferenceWindow.webContents.userAgent.replace(/Electron\S+/i, '')}SPlayerX@2018 Platform/${os.platform()} Release/${os.release()} Version/${app.getVersion()} EnvironmentName/${environmentName}`;
  } else {
    if (!preferenceWindow.webContents.isDestroyed()) {
      preferenceWindow.webContents.send('route-change', route);
    }
    preferenceWindow.focus();
  }
  preferenceWindow.once('ready-to-show', () => {
    preferenceWindow.show();
  });
  preferenceWindow.on('focus', () => {
    menuService?.enableMenu(false);
  });
  if (process.platform === 'win32') {
    hackWindowsRightMenu(preferenceWindow);
  }
  setBoundsCenterByOriginWindow(mainWindow, preferenceWindow, 540, 426);
  if (!premiumView) {
    // 预先加载好PremiumView
    createPremiumView(e, route);
    preferenceWindow.removeWebContentsView(premiumView);
  }
}


function createAboutWindow() {
  const aboutWindowOptions = {
    useContentSize: true,
    frame: false,
    titleBarStyle: 'none',
    width: 230,
    height: 300,
    transparent: true,
    resizable: false,
    show: false,
    webPreferences: {
      contextIsolation: false,
      webSecurity: false,
      nodeIntegration: true,
      experimentalFeatures: true,
    },
    acceptFirstMouse: true,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
  };
  if (!aboutWindow) {
    aboutWindow = new BrowserWindow(aboutWindowOptions);
    // 如果播放窗口顶置，打开关于也顶置
    if (mainWindow && mainWindow.isAlwaysOnTop()) {
      aboutWindow.setAlwaysOnTop(true);
    }
    aboutWindow.loadURL(`${aboutURL}`);
    aboutWindow.on('closed', () => {
      aboutWindow = null;
    });
  }
  aboutWindow.once('ready-to-show', () => {
    aboutWindow.show();
  });
  if (process.platform === 'win32') {
    hackWindowsRightMenu(aboutWindow);
  }
}

function createDownloadWindow(args) {
  const downloadWindowOptions = {
    useContentSize: true,
    frame: false,
    titleBarStyle: 'none',
    width: 460,
    minWidth: 460,
    maxWidth: 460,
    height: 500,
    minHeight: 500,
    resizable: true,
    webPreferences: {
      contextIsolation: false,
      webSecurity: false,
      nodeIntegration: true,
      sandbox: false,
      experimentalFeatures: true,
      webviewTag: true,
      preload: `${require('path').resolve(__static, 'download/downloadWindowPreload.js')}`,
      devTools: false,
    },
    backgroundColor: '#FFFFFF',
    acceptFirstMouse: false,
    show: false,
  };
  downloadWindow = new BrowserWindow(downloadWindowOptions);
  downloadWindow.loadURL(`${downloadURL}`);
  downloadWindow.on('closed', () => {
    downloadWindow = null;
    if (process.platform === 'win32' && isGlobal) {
      app.quit();
    }
  });
  downloadWindow.once('ready-to-show', () => {
    if (args.show) downloadWindow.show();
    if (Object.prototype.toString.call(args.info).toLowerCase() === '[object array]') {
      downloadWindow.send('continue-download-video', args.info);
    } else if (Object.prototype.toString.call(args.info).toLowerCase() === '[object object]' && !manualAbort) {
      downloadWindow.send('download-video', args.info);
    }
    manualAbort = false;
  });
}
function createBrowsingWindow(args) {
  const browsingWindowOptions = {
    useContentSize: true,
    frame: false,
    titleBarStyle: 'none',
    webPreferences: {
      contextIsolation: false,
      webSecurity: false,
      nodeIntegration: true,
      experimentalFeatures: true,
      webviewTag: true,
    },
    backgroundColor: '#000000',
    acceptFirstMouse: false,
    show: false,
  };
  browsingWindow = new BrowserWindow(browsingWindowOptions);
  browsingWindow.loadURL(`${browsingURL}`);
  browsingWindow.on('closed', () => {
    browsingWindow = null;
    if (process.platform === 'win32' && isGlobal) {
      app.quit();
    }
  });
  browsingWindow.once('ready-to-show', () => {
    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
      if (details.requestHeaders.Cookie) {
        if (downloadWindow) downloadWindow.send('download-headers', details.requestHeaders);
        if (mainWindow) mainWindow.send('get-info-cookie', details.requestHeaders.Cookie);
      }
      callback({ requestHeaders: details.requestHeaders });
    });
  });
  if (browsingWindow) {
    browsingWindow.setSize(args.size[0], args.size[1]);
    if (args.position.length) {
      browsingWindow.setPosition(args.position[0], args.position[1]);
    }
    browsingWindow.on('focus', () => {
      menuService?.updateFocusedWindow(false, mainWindow && mainWindow.isVisible());
    });
    browsingWindow.on('move', throttle(() => {
      if (!mainWindow) return;
      mainWindow.send('update-pip-pos', browsingWindow.getPosition());
    }, 100));
    browsingWindow.on('always-on-top-changed', (e, top) => {
      if (pipControlView) {
        pipControlView.webContents.executeJavaScript(InjectJSManager.updatePinState(top));
      }
    });
    browsingWindow.on('leave-full-screen', () => {
      if (hideBrowsingWindow) {
        hideBrowsingWindow = false;
        browsingWindow.hide();
        setTimeout(() => {
          mainWindow.focus();
        }, 0);
      }
    });
  }
}

function createPaymentWindow(url, orderID, channel) {
  if (!preferenceWindow) return;
  const width = channel === 'wxpay' ? 270 : 1200;
  const height = channel === 'wxpay' ? 462 : 890;
  const paymentWindowOptions = {
    useContentSize: true,
    frame: false,
    titleBarStyle: 'none',
    width,
    height,
    transparent: true,
    resizable: false,
    show: false,
    webPreferences: {
      contextIsolation: false,
      webSecurity: false,
      nodeIntegration: true,
      experimentalFeatures: true,
      webviewTag: true,
    },
    acceptFirstMouse: true,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
  };
  if (!paymentWindow) {
    paymentWindow = new BrowserWindow(paymentWindowOptions);
    // 如果播放窗口顶置，打开关于也顶置
    if (mainWindow && mainWindow.isAlwaysOnTop()) {
      paymentWindow.setAlwaysOnTop(true);
    }
    paymentWindow.loadURL(`${paymentURL}?url=${url}&orderID=${orderID}&type=${channel}`);
    paymentWindow.on('closed', () => {
      if (premiumView && !premiumView.webContents.isDestroyed()
        && !paymentWindowCloseTag) {
        premiumView.webContents.send('close-payment');
      }
      if (preferenceWindow && !preferenceWindow.webContents.isDestroyed()) {
        preferenceWindow.webContents.send('close-payment');
      }
      paymentWindow = null;
      paymentWindowCloseTag = false;
    });
  } else {
    paymentWindow.focus();
    paymentWindow.setBounds({
      width,
      height,
    });
    paymentWindow.loadURL(`${paymentURL}?url=${url}&orderID=${orderID}&type=${channel}`);
  }
  paymentWindow.once('ready-to-show', () => {
    paymentWindow.show();
  });
  if (process.platform === 'win32') {
    hackWindowsRightMenu(paymentWindow);
  }
  setBoundsCenterByOriginWindow(preferenceWindow, paymentWindow, width, height);
  if (preferenceWindow && !preferenceWindow.webContents.isDestroyed()) {
    preferenceWindow.webContents.send('add-payment');
  }
}

function createLosslessStreamingWindow() {
  if (losslessStreamingWindow && !losslessStreamingWindow.webContents.isDestroyed()) {
    losslessStreamingWindow.focus();
    return;
  }
  const losslessStreamingWindowOptions = {
    frame: false,
    titleBarStyle: 'none',
    minWidth: 300,
    maxWidth: 300,
    minHeight: 350,
    width: 300,
    height: 400,
    transparent: true,
    resizable: true,
    show: false,
    webPreferences: {
      contextIsolation: false,
      webSecurity: false,
      nodeIntegration: true,
      experimentalFeatures: true,
    },
    acceptFirstMouse: true,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
  };
  if (!losslessStreamingWindow) {
    losslessStreamingWindow = new BrowserWindow(losslessStreamingWindowOptions);
    const info = losslessStreamingInstance.getInfo();
    losslessStreamingWindow.loadURL(`${losslessStreamingURL}?${qs.stringify(info)}`);
    losslessStreamingWindow.on('closed', () => {
      losslessStreamingWindow = null;
    });
  }
  losslessStreamingWindow.once('ready-to-show', () => {
    losslessStreamingWindow.show();
    losslessStreamingWindow.focus();
  });
  if (process.platform === 'win32') {
    hackWindowsRightMenu(losslessStreamingWindow);
  }
}


function openHistoryItem(evt, args) {
  if (!webContentsViewManager) webContentsViewManager = new WebContentsViewManager();
  if (!availableChannels.find(i => [args.channel, calcCurrentChannel(args.url)]
    .includes(i.channel))) {
    mainWindow.send('add-temporary-site', args);
  } else {
    const newChannel = webContentsViewManager.openHistoryPage(args.channel, args.url);
    const view = newChannel.view ? newChannel.view : newChannel.page.view;
    mainWindow.addWebContentsView(view);
    mainWindow.send('update-browser-state', {
      url: args.url,
      canGoBack: newChannel.canBack,
      canGoForward: newChannel.canForward,
    });
    const bounds = mainWindow.getBounds();
    if (process.platform === 'win32' && mainWindow.isMaximized() && (bounds.x < 0 || bounds.y < 0)) {
      view.setBounds({
        x: sidebar ? 76 : 0,
        y: 40,
        width: sidebar ? bounds.width + (bounds.x * 2) - 76
          : bounds.width + (bounds.x * 2),
        height: bounds.height - 40,
      });
    } else {
      view.setBounds({
        x: sidebar ? 76 : 0,
        y: 40,
        width: sidebar ? mainWindow.getSize()[0] - 76 : mainWindow.getSize()[0],
        height: mainWindow.getSize()[1] - 40,
      });
    }
    mainWindow.setWebContentsViewAutoResize(view, {
      width: true, height: true,
    });
  }
}

function registerMainWindowEvent(playerWindow) {
  if (!playerWindow) return;
  playerWindow.on('move', throttle(() => {
    if (!isUsableMainWindow(playerWindow)) return;
    playerWindow.webContents.send('mainCommit', 'windowPosition', playerWindow.getPosition());
  }, 100));
  playerWindow.on('enter-full-screen', () => {
    if (!isUsableMainWindow(playerWindow)) return;
    playerWindow.webContents.send('mainCommit', 'isFullScreen', true);
    playerWindow.webContents.send('mainCommit', 'isMaximized', playerWindow.isMaximized());
  });
  playerWindow.on('leave-full-screen', () => {
    if (!isUsableMainWindow(playerWindow)) return;
    playerWindow.webContents.send('mainCommit', 'isFullScreen', false);
    playerWindow.webContents.send('mainCommit', 'isMaximized', playerWindow.isMaximized());
  });
  playerWindow.on('maximize', () => {
    if (!isUsableMainWindow(playerWindow)) return;
    playerWindow.webContents.send('mainCommit', 'isMaximized', true);
    playerWindow.webContents.send('mainCommit', 'windowPosition', playerWindow.getPosition());
  });
  playerWindow.on('unmaximize', () => {
    if (!isUsableMainWindow(playerWindow)) return;
    playerWindow.webContents.send('mainCommit', 'isMaximized', false);
    playerWindow.webContents.send('mainCommit', 'windowPosition', playerWindow.getPosition());
  });
  playerWindow.on('minimize', () => {
    menuService?.enableMenu(false);
    if (!isUsableMainWindow(playerWindow)) return;
    playerWindow.webContents.send('mainCommit', 'isMinimized', true);
  });
  playerWindow.on('restore', () => {
    menuService?.enableMenu(true);
    if (!isUsableMainWindow(playerWindow)) return;
    playerWindow.webContents.send('mainCommit', 'isMinimized', false);
  });
  playerWindow.on('show', () => {
    if (!isUsableMainWindow(playerWindow)) return;
    playerWindow.webContents.send('mainCommit', 'isMinimized', false);
  });
  playerWindow.on('focus', () => {
    if (!isUsableMainWindow(playerWindow)) return;
    restoreMainWindowMenu(playerWindow);
    playerWindow.webContents.send('mainCommit', 'isFocused', true);
    playerWindow.webContents.send('mainCommit', 'isHiddenByBossKey', false);
  });
  playerWindow.on('blur', () => {
    if (!isUsableMainWindow(playerWindow)) return;
    playerWindow.webContents.send('mainCommit', 'isFocused', false);
  });
  playerWindow.on('scroll-touch-begin', () => {
    if (!isUsableMainWindow(playerWindow)) return;
    playerWindow.webContents.send('scroll-touch-begin');
  });
  playerWindow.on('scroll-touch-end', () => {
    if (!isUsableMainWindow(playerWindow)) return;
    playerWindow.webContents.send('scroll-touch-end');
  });

  if (mainProcessEventsRegistered) return;
  mainProcessEventsRegistered = true;

  registerMediaTasks();

  ipcMain.on('callBrowsingWindowMethod', (evt, method, args = []) => {
    try {
      browsingWindow[method](...args);
    } catch (ex) {
      console.error('callBrowsingWindowMethod', method, JSON.stringify(args), '\n', ex);
    }
  });
  ipcMain.on('update-available-channels', (e, channels) => {
    availableChannels = channels;
  });
  ipcMain.on('open-url-window', () => {
    createOpenUrlWindow();
  });
  ipcMain.on('send-url', (e, urlInfo) => {
    const targetWindow = getSenderMainWindow(e.sender);
    if (targetWindow) targetWindow.webContents.send('send-url', urlInfo);
  });
  ipcMain.on('browser-window-mask', () => {
    if (!browsingWindow.getWebContentsViews().includes(maskView)) createMaskView();
    clearTimeout(maskEventTimer);
    maskEventTimer = setTimeout(() => {
      if (maskView) {
        maskView.webContents.executeJavaScript(`
          document.body.style.backgroundColor = 'rgba(255, 255, 255, 0)';
          `);
        clearTimeout(maskDisappearTimer);
        maskDisappearTimer = setTimeout(() => {
          if (browsingWindow) browsingWindow.removeWebContentsView(maskView);
        }, 120);
      }
    }, 300);
  });
  ipcMain.on('setFocusedWindowPosition', (evt, args) => {
    try {
      BrowserWindow.getFocusedWindow().setPosition(args[0], args[1]);
    } catch (ex) {
      console.error('setFocusedWindowPosition error', JSON.stringify(args), '\n', ex);
    }
  });
  ipcMain.on('callMainWindowMethod', (evt, method, args = []) => {
    try {
      const targetWindow = getSenderMainWindow(evt.sender);
      if (targetWindow) targetWindow[method](...args);
    } catch (ex) {
      console.error('callMainWindowMethod', method, JSON.stringify(args), '\n', ex);
    }
  });
  ipcMain.on('pip-watcher', (evt, args) => {
    browsingWindow.getWebContentsViews()[0].webContents.executeJavaScript(args);
  });
  ipcMain.on('update-locale', () => {
    locale.refreshDisplayLanguage();
    if (pipControlView && !pipControlView.isDestroyed()) {
      pipControlViewTitle(isGlobal);
    }
  });
  ipcMain.on('pip-window-fullscreen', () => {
    if (browsingWindow && browsingWindow.isFocused()) {
      browsingWindow.setFullScreen(!browsingWindow.isFullScreen());
      titlebarView.webContents.executeJavaScript(InjectJSManager
        .updateFullScreenIcon(browsingWindow.isFullScreen(), isBrowsingWindowMax));
    }
  });
  ipcMain.on('pip-window-close', (evt, args) => {
    const views = browsingWindow.getWebContentsViews();
    if (views.length) {
      views.forEach((view) => {
        browsingWindow.removeWebContentsView(view);
      });
      webContentsViewManager.pipClose();
      mainWindow.send('update-pip-state', args);
    }
  });
  ipcMain.on('remove-main-window', () => {
    webContentsViewManager.pauseVideo(mainWindow.getWebContentsViews()[0]);
    mainWindow.hide();
  });
  ipcMain.on('clear-browsers-by-channel', (evt, channel) => {
    if (!webContentsViewManager) return;
    webContentsViewManager.clearWebContentsViewsByChannel(channel);
  });
  ipcMain.on('remove-browser', () => {
    if (!webContentsViewManager) return;
    if (mainWindow.getWebContentsViews().length) webContentsViewManager.pauseVideo();
    mainWindow.getWebContentsViews()
      .forEach(mainWindowView => mainWindow.removeWebContentsView(mainWindowView));
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    if (browsingWindow) {
      const views = browsingWindow.getWebContentsViews();
      views.forEach((view) => {
        browsingWindow.removeWebContentsView(view);
      });
      webContentsViewManager.pipClose();
      browsingWindow.close();
    }
    webContentsViewManager.clearAllWebContentsViews();
  });
  ipcMain.on('go-to-offset', (evt, val) => {
    if (!webContentsViewManager) return;
    mainWindow.removeWebContentsView(mainWindow.getWebContentsViews()[0]);
    const newBrowser = val === 1 ? webContentsViewManager.forward() : webContentsViewManager.back();
    if (newBrowser.page) {
      mainWindow.addWebContentsView(newBrowser.page.view);
      mainWindow.send('update-browser-state', {
        url: newBrowser.page.url,
        canGoBack: newBrowser.canBack,
        canGoForward: newBrowser.canForward,
      });
      const bounds = mainWindow.getBounds();
      if (process.platform === 'win32' && mainWindow.isMaximized() && (bounds.x < 0 || bounds.y < 0)) {
        newBrowser.page.view.setBounds({
          x: sidebar ? 76 : 0,
          y: 40,
          width: sidebar ? bounds.width + (bounds.x * 2) - 76
            : bounds.width + (bounds.x * 2),
          height: bounds.height - 40,
        });
      } else {
        newBrowser.page.view.setBounds({
          x: sidebar ? 76 : 0,
          y: 40,
          width: sidebar ? mainWindow.getSize()[0] - 76 : mainWindow.getSize()[0],
          height: mainWindow.getSize()[1] - 40,
        });
      }
      mainWindow.setWebContentsViewAutoResize(newBrowser.page.view, {
        width: true, height: true,
      });
    }
  });
  ipcMain.on('open-history-item', openHistoryItem);
  ipcMain.on('remove-web-page', () => {
    if (!webContentsViewManager) webContentsViewManager = new WebContentsViewManager();
    const mainBrowser = mainWindow.getWebContentsViews()[0];
    if (mainBrowser) {
      webContentsViewManager.pauseVideo();
      mainWindow.removeWebContentsView(mainBrowser);
    }
  });
  ipcMain.on('change-channel', (evt, args) => {
    if (!webContentsViewManager) webContentsViewManager = new WebContentsViewManager();
    const mainBrowser = mainWindow.getWebContentsViews()[0];
    if (mainBrowser) {
      mainWindow.removeWebContentsView(mainBrowser);
    } else {
      webContentsViewManager.setCurrentChannel('');
    }
    const newChannel = webContentsViewManager.changeChannel(args.channel, args);
    const view = newChannel.view ? newChannel.view : newChannel.page.view;
    const url = newChannel.view ? args.url : newChannel.page.url;
    mainWindow.addWebContentsView(view);
    setTimeout(() => {
      mainWindow.send('update-browser-state', {
        url,
        canGoBack: newChannel.canBack,
        canGoForward: newChannel.canForward,
      });
    }, 150);
    if (!view.isDestroyed()) {
      const bounds = mainWindow.getBounds();
      if (process.platform === 'win32' && mainWindow.isMaximized() && (bounds.x < 0 || bounds.y < 0)) {
        view.setBounds({
          x: sidebar ? 76 : 0,
          y: 40,
          width: sidebar ? bounds.width + (bounds.x * 2) - 76
            : bounds.width + (bounds.x * 2),
          height: bounds.height - 40,
        });
      } else {
        view.setBounds({
          x: sidebar ? 76 : 0,
          y: 40,
          width: sidebar ? mainWindow.getSize()[0] - 76 : mainWindow.getSize()[0],
          height: mainWindow.getSize()[1] - 40,
        });
      }
      mainWindow.setWebContentsViewAutoResize(view, {
        width: true, height: true,
      });
    }
  });
  ipcMain.on('create-browser-view', (evt, args) => {
    if (!webContentsViewManager) webContentsViewManager = new WebContentsViewManager();
    const currentMainWebContentsView = webContentsViewManager.create(args.channel, args);
    mainWindow.send('update-browser-state', {
      url: args.url,
      canGoBack: currentMainWebContentsView.canBack,
      canGoForward: currentMainWebContentsView.canForward,
    });
  });
  ipcMain.on('update-danmu-state', (evt, val) => {
    pipControlView.webContents.executeJavaScript(InjectJSManager.initBarrageIcon(val));
  });
  ipcMain.on('pin', () => {
    mainWindow.send('pip-float-on-top');
  });
  ipcMain.on('pip', () => {
    mainWindow.send('handle-exit-pip');
  });
  ipcMain.on('danmu', () => {
    mainWindow.send('handle-danmu-display');
  });
  ipcMain.on('handle-danmu-display', (evt, code) => {
    browsingWindow.getWebContentsViews()[0].webContents.executeJavaScript(code);
  });
  ipcMain.on('mousemove', () => {
    if (browsingWindow && browsingWindow.isFocused()) {
      pipControlView.webContents.executeJavaScript(InjectJSManager.updatePipControlState(true));
      titlebarView.webContents.executeJavaScript(InjectJSManager.updatePipTitlebarToShow(true));
      if (pipTimer) {
        clearTimeout(pipTimer);
      }
      pipTimer = setTimeout(() => {
        if (pipControlView && !pipControlView.isDestroyed()) {
          pipControlView.webContents
            .executeJavaScript(InjectJSManager.updatePipControlState(false));
          titlebarView.webContents
            .executeJavaScript(InjectJSManager.updatePipTitlebarToShow(false));
        }
      }, 3000);
    }
  });
  ipcMain.on('pip-btn-mousemove', () => {
    if (pipTimer) {
      clearTimeout(pipTimer);
    }
  });
  ipcMain.on('pip-btn-mouseout', () => {
    if (pipTimer) {
      clearTimeout(pipTimer);
    }
    pipTimer = setTimeout(() => {
      if (pipControlView && !pipControlView.isDestroyed()) {
        pipControlView.webContents.executeJavaScript(InjectJSManager.updatePipControlState(false));
      }
    }, 3000);
  });
  ipcMain.on('mouseout', () => {
    if (browsingWindow && browsingWindow.isFocused()) {
      if (pipTimer) {
        clearTimeout(pipTimer);
      }
      pipControlView.webContents.executeJavaScript(InjectJSManager.updatePipControlState(false));
      titlebarView.webContents.executeJavaScript(InjectJSManager.updatePipTitlebarToShow(false));
    }
  });
  ipcMain.on('maximizable', (evt, val) => {
    if (val) {
      titlebarView.webContents.executeJavaScript(InjectJSManager.updateTitlebarState('.titlebarMax', true)
        + InjectJSManager.updateTitlebarState('.titlebarFull', false));
    } else {
      titlebarView.webContents.executeJavaScript(InjectJSManager.updateTitlebarState('.titlebarMax', false)
        + InjectJSManager.updateTitlebarState('.titlebarFull', true));
    }
  });
  ipcMain.on('update-mouse-info', (evt, args) => {
    if (browsingWindow && browsingWindow.isFocused()) {
      browsingWindow.send('update-mouse-info', args);
    }
  });
  ipcMain.on('update-full-state', (evt, isFullScreen) => {
    titlebarView.webContents.executeJavaScript(InjectJSManager
      .updateFullScreenIcon(isFullScreen, isBrowsingWindowMax));
  });
  ipcMain.on('mouseup', (evt, type) => {
    switch (type) {
      case 'close':
        browsingWindow.close();
        break;
      case 'min':
        browsingWindow.minimize();
        break;
      case 'full':
        browsingWindow.setFullScreen(true);
        titlebarView.webContents.executeJavaScript(InjectJSManager
          .updateFullScreenIcon(true, isBrowsingWindowMax));
        break;
      case 'recover':
        browsingWindow.setFullScreen(false);
        browsingWindow.getWebContentsViews()[0].webContents
          .executeJavaScript(InjectJSManager.changeFullScreen(false));
        titlebarView.webContents.executeJavaScript(InjectJSManager
          .updateFullScreenIcon(false, isBrowsingWindowMax));
        break;
      case 'max':
        if (browsingWindow.isMaximized()) {
          browsingWindow.unmaximize();
          isBrowsingWindowMax = false;
        } else {
          browsingWindow.maximize();
          isBrowsingWindowMax = true;
          if (process.platform === 'win32') {
            titlebarView.webContents.executeJavaScript(InjectJSManager.updateWinMaxIcon(true));
          }
        }
        break;
      case 'unmax':
        browsingWindow.unmaximize();
        isBrowsingWindowMax = false;
        if (process.platform === 'win32') {
          titlebarView.webContents.executeJavaScript(InjectJSManager.updateWinMaxIcon(false));
        }
        break;
      default:
        break;
    }
  });
  ipcMain.on('shift-pip', (evt, args) => {
    if (!webContentsViewManager) return;
    const mainWindowViews = mainWindow.getWebContentsViews();
    mainWindowViews
      .forEach(mainWindowView => mainWindow.removeWebContentsView(mainWindowView));
    const browViews = browsingWindow.getWebContentsViews();
    browViews.forEach((view) => {
      browsingWindow.removeWebContentsView(view);
    });
    const browsers = webContentsViewManager.changePip(args.channel);
    const pipBrowser = browsers.pipBrowser;
    const mainBrowser = browsers.mainBrowser;
    mainWindow.addWebContentsView(mainBrowser.page.view);
    browsingWindow.addWebContentsView(pipBrowser);
    createPipControlView();
    createTitlebarView();
    if (args.isGlobal) {
      isGlobal = args.isGlobal;
      webContentsViewManager.pauseVideo(mainWindow.getWebContentsViews()[0]);
      mainWindow.hide();
    }
    mainBrowser.page.view.setBounds({
      x: sidebar ? 76 : 0,
      y: 40,
      width: sidebar ? mainWindow.getSize()[0] - 76 : mainWindow.getSize()[0],
      height: mainWindow.getSize()[1] - 40,
    });
    mainWindow.setWebContentsViewAutoResize(mainBrowser.page.view, {
      width: true, height: true,
    });
    pipBrowser.setBounds({
      x: 0, y: 0, width: browsingWindow.getSize()[0], height: browsingWindow.getSize()[1],
    });
    browsingWindow.setWebContentsViewAutoResize(pipBrowser, {
      width: true, height: true,
    });
    mainWindow.send('update-browser-state', {
      url: mainBrowser.page.url,
      canGoBack: mainBrowser.canBack,
      canGoForward: mainBrowser.canForward,
    });
    pipControlView.webContents
      .executeJavaScript(InjectJSManager.updateBarrageState(args.barrageOpen, args.opacity));
    menuService?.updateFocusedWindow(false, mainWindow && mainWindow.isVisible());
    browsingWindow.focus();
  });
  ipcMain.on('enter-pip', (evt, args) => {
    if (!webContentsViewManager) return;
    const browsers = webContentsViewManager.enterPip();
    const pipBrowser = browsers.pipBrowser;
    const mainBrowser = browsers.mainBrowser;
    if (!browsingWindow) {
      createBrowsingWindow({ size: args.pipInfo.pipSize, position: args.pipInfo.pipPos });
      mainWindow.send('init-pip-position');
      mainWindow.removeWebContentsView(mainWindow.getWebContentsViews()[0]);
      mainWindow.addWebContentsView(mainBrowser.page.view);
      browsingWindow.addWebContentsView(pipBrowser);
      createPipControlView();
      createTitlebarView();
      browsingWindow.show();
    } else {
      mainWindow.removeWebContentsView(mainWindow.getWebContentsViews()[0]);
      mainWindow.addWebContentsView(mainBrowser.page.view);
      browsingWindow.addWebContentsView(pipBrowser);
      browsingWindow.setSize(420, 236);
      createPipControlView();
      createTitlebarView();
      browsingWindow.show();
    }
    if (args.isGlobal) {
      isGlobal = args.isGlobal;
      mainWindow.hide();
    }
    browsingWindow.webContents.closeDevTools();
    browsingWindow.setAspectRatio(args.pipInfo.aspectRatio);
    browsingWindow.setMinimumSize(args.pipInfo.minimumSize[0], args.pipInfo.minimumSize[1]);
    browsingWindow.setSize(args.pipInfo.pipSize[0], args.pipInfo.pipSize[1]);
    mainBrowser.page.view.setBounds({
      x: sidebar ? 76 : 0,
      y: 40,
      width: sidebar ? mainWindow.getSize()[0] - 76 : mainWindow.getSize()[0],
      height: mainWindow.getSize()[1] - 40,
    });
    mainWindow.setWebContentsViewAutoResize(mainBrowser.page.view, {
      width: true,
      height: true,
    });
    pipBrowser.setBounds({
      x: 0, y: 0, width: browsingWindow.getSize()[0], height: browsingWindow.getSize()[1],
    });
    browsingWindow.setWebContentsViewAutoResize(pipBrowser, {
      width: true, height: true,
    });
    browsingWindow.send('update-pip-listener');
    mainWindow.send('update-browser-state', {
      url: mainBrowser.page.url,
      canGoBack: mainBrowser.canBack,
      canGoForward: mainBrowser.canForward,
    });
    pipControlView.webContents
      .executeJavaScript(InjectJSManager.updateBarrageState(args.barrageOpen, args.opacity));
    pipControlViewTitle(args.isGlobal);
    menuService?.updateFocusedWindow(false, mainWindow && mainWindow.isVisible());
    browsingWindow.focus();
  });
  ipcMain.on('update-pip-size', (evt, args) => {
    mainWindow.send('update-pip-size', args);
  });
  ipcMain.on('update-sidebar', (evt, sidebarstate) => {
    sidebar = sidebarstate;
    if (downloadListView && !downloadListView.isDestroyed()) {
      downloadListView.setBounds({
        x: sidebar ? 76 : 0,
        y: 40,
        width: sidebar ? mainWindow.getSize()[0] - 76 : mainWindow.getSize()[0],
        height: mainWindow.getSize()[1] - 40,
      });
    }
  });
  ipcMain.on('set-bounds', (evt, args) => {
    if (pipControlView) pipControlView.setBounds(args.control);
    if (titlebarView) titlebarView.setBounds(args.titlebar);
  });
  ipcMain.on('show-download-list', (evt, info) => {
    if (!downloadListView || downloadListView.isDestroyed()) {
      createDownloadListView(info.title, info.list, info.url,
        true, info.resolution, info.path); // set no limits
    }
  });
  ipcMain.on('update-download-list', () => {
    isVip = true; // set no limits
    if (downloadListView && !downloadListView.isDestroyed()) {
      downloadListView.webContents.send('update-is-vip', isVip);
      if (!isVip) {
        const lastTime = new Date(lastDownloadDate);
        const newTime = new Date();
        const lastDate = lastTime.getDate();
        const lastMonth = lastTime.getMonth();
        const lastYear = lastTime.getFullYear();
        const nowDate = newTime.getDate();
        const nowMonth = newTime.getMonth();
        const nowYear = newTime.getFullYear();
        const available = (lastDate !== nowDate || lastMonth !== nowMonth || lastYear !== nowYear)
          && Date.now() > lastDownloadDate;
        if (!available) downloadListView.webContents.send('update-download-state', 'limited');
      }
    }
  });
  ipcMain.on('close-download-list', (evt, id) => {
    if (downloadListView && !downloadListView.isDestroyed()) {
      mainWindow.removeWebContentsView(downloadListView);
      downloadListView.destroy();
    }
    manualAbort = true;
    if (downloadWindow && id) downloadWindow.send('abort-download', id);
  });
  ipcMain.on('open-download-list', () => {
    if (!downloadWindow) {
      createDownloadWindow({ show: true });
    } else {
      downloadWindow.show();
    }
  });
  ipcMain.on('downloading-network-error', (evt, id) => {
    if (downloadWindow) downloadWindow.send('downloading-network-error', id);
  });
  ipcMain.on('show-notification', (evt, info) => {
    const notification = new Notification({ title: locale.$t('browsing.download.downloadCompleted'), body: info.name });
    notification.show();
    notification.on('click', () => {
      shell.showItemInFolder(join(info.path, info.name));
    });
  });
  ipcMain.on('not-found-vc-packages', () => {
    const notification = new Notification({ title: locale.$t('browsing.download.vcRuntime') });
    notification.show();
    notification.on('click', () => {
      shell.openExternal('https://www.microsoft.com/en-US/download/details.aspx?id=5555');
    });
  });
  ipcMain.on('transfer-download-info', (evt, info) => {
    if (downloadWindow) {
      downloadWindow.send('transfer-download-info', info);
      downloadWindow.show();
      mainWindow.send('store-download-date');
    }
    mainWindow.removeWebContentsView(downloadListView);
    downloadListView.destroy();
  });
  ipcMain.on('download-item-detail', (evt, info) => {
    if (downloadWindow) {
      downloadWindow.send('add-download-item', info);
    }
  });
  ipcMain.on('transfer-progress', (evt, progress) => {
    downloadWindow.send('transfer-progress', progress);
  });
  ipcMain.on('update-download-date', (evt, date) => {
    lastDownloadDate = date;
  });
  ipcMain.on('start-download-error', () => {
    if (downloadListView && !downloadListView.isDestroyed()) {
      downloadListView.webContents.send('start-download-error');
    }
  });
  ipcMain.on('download-video', (evt, info) => {
    manualAbort = false;
    if (downloadListView && !downloadListView.isDestroyed()) {
      downloadListView.webContents.send('update-download-state', 'loading');
    }
    if (!downloadWindow) {
      createDownloadWindow({
        show: false, info: Object.assign(info, { date: lastDownloadDate }),
      });
    } else downloadWindow.send('download-video', Object.assign(info, { date: lastDownloadDate }));
  });
  ipcMain.on('continue-download-list', (evt, data) => {
    if (!downloadWindow) createDownloadWindow({ show: false, info: data });
    else downloadWindow.send('continue-download-video', data);
  });
  ipcMain.on('exit-pip', (evt, args) => {
    if (!webContentsViewManager) return;
    browsingWindow.send('remove-pip-listener');
    mainWindow.show();
    mainWindow.getWebContentsViews()
      .forEach(mainWindowView => mainWindow.removeWebContentsView(mainWindowView));
    const browViews = browsingWindow.getWebContentsViews();
    browViews.forEach((view) => {
      browsingWindow.removeWebContentsView(view);
    });
    const exitBrowser = webContentsViewManager.exitPip();
    exitBrowser.page.view.webContents.executeJavaScript(args.jsRecover);
    if (args.cssRecover) exitBrowser.page.view.webContents.insertCSS(args.cssRecover);
    mainWindow.addWebContentsView(exitBrowser.page.view);
    exitBrowser.page.view.setBounds({
      x: sidebar ? 76 : 0,
      y: 40,
      width: sidebar ? mainWindow.getSize()[0] - 76 : mainWindow.getSize()[0],
      height: mainWindow.getSize()[1] - 40,
    });
    mainWindow.setWebContentsViewAutoResize(exitBrowser.page.view, {
      width: true,
      height: true,
    });
    mainWindow.send('update-browser-state', {
      url: exitBrowser.page.url,
      canGoBack: exitBrowser.canBack,
      canGoForward: exitBrowser.canForward,
    });
    if (browsingWindow.isFullScreen()) {
      hideBrowsingWindow = true;
      browsingWindow.setFullScreen(false);
      exitBrowser.page.view.webContents.executeJavaScript('document.webkitCancelFullScreen();');
    } else {
      browsingWindow.hide();
    }
    mainWindow.show();
    menuService?.updateFocusedWindow(true, mainWindow && mainWindow.isVisible());
  });
  ipcMain.on('set-window-minimize', (event) => {
    const targetWindow = getSenderMainWindow(event.sender);
    if (targetWindow && targetWindow.isFocused()) {
      if (targetWindow.isMinimized()) {
        targetWindow.restore();
      } else {
        targetWindow.minimize();
      }
    } else if (browsingWindow && browsingWindow.isFocused()) {
      if (browsingWindow.isMinimized()) {
        browsingWindow.restore();
      } else {
        browsingWindow.minimize();
      }
    }
  });
  // eslint-disable-next-line complexity
  ipcMain.on('set-window-maximize', (event) => {
    const targetWindow = getSenderMainWindow(event.sender);
    if (targetWindow && targetWindow.isFocused()) {
      if (targetWindow.isMaximized()) {
        targetWindow.unmaximize();
      } else {
        targetWindow.maximize();
      }
      const [mainWebContentsView] = targetWindow.getWebContentsViews();
      if (mainWebContentsView && !mainWebContentsView.isDestroyed()) {
        const bounds = targetWindow.getBounds();
        if (process.platform === 'win32' && targetWindow.isMaximized() && (bounds.x < 0 || bounds.y < 0)) {
          targetWindow.getWebContentsViews()[0].setBounds({
            x: sidebar ? 76 : 0,
            y: 40,
            width: sidebar ? bounds.width + (bounds.x * 2) - 76
              : bounds.width + (bounds.x * 2),
            height: bounds.height - 40,
          });
        } else {
          targetWindow.getWebContentsViews()[0].setBounds({
            x: sidebar ? 76 : 0,
            y: 40,
            width: sidebar ? targetWindow.getSize()[0] - 76
              : targetWindow.getSize()[0],
            height: targetWindow.getSize()[1] - 40,
          });
        }
      }
    } else if (browsingWindow && browsingWindow.isFocused()) {
      if (!isBrowsingWindowMax) {
        browsingWindow.maximize();
        isBrowsingWindowMax = true;
        if (process.platform === 'win32') {
          titlebarView.webContents.executeJavaScript(InjectJSManager.updateWinMaxIcon(true));
        }
      } else {
        browsingWindow.unmaximize();
        isBrowsingWindowMax = false;
        if (process.platform === 'win32') {
          titlebarView.webContents.executeJavaScript(InjectJSManager.updateWinMaxIcon(false));
        }
      }
    }
  });
  ipcMain.on('update-route-name', (e, route) => {
    routeName = route;
  });
  ipcMain.on('key-events', (e, keyCode) => {
    if (keyCode === 13) {
      browsingWindow.setFullScreen(!browsingWindow.isFullScreen());
      titlebarView.webContents.executeJavaScript(InjectJSManager
        .updateFullScreenIcon(browsingWindow.isFullScreen(), isBrowsingWindowMax));
    } else {
      browsingWindow.getWebContentsViews()[0].webContents
        .executeJavaScript(InjectJSManager.emitKeydownEvent(keyCode));
    }
  });
  ipcMain.on('drop-subtitle', (event, args) => {
    const targetWindow = getSenderMainWindow(event.sender);
    if (!targetWindow) return;
    const subtitleFiles = [];
    const videoFiles = [];
    args.forEach((file) => {
      if (isSubtitle((file)) || fs.statSync(file).isDirectory()) {
        subtitleFiles.push(file);
      } else if (isVideo(file) || isAudio(file)) {
        videoFiles.push(file);
      }
    });
    const filesToOpen = getAllValidVideo(!videoFiles.length,
      videoFiles.concat(subtitleFiles));
    if (process.mas && !videoFiles.length && subtitleFiles.length && !filesToOpen) {
      targetWindow.webContents.send('open-subtitle-in-mas', subtitleFiles[0]);
    } else if (videoFiles.length + subtitleFiles.length > 0) {
      targetWindow.webContents.send('open-file', {
        onlySubtitle: !videoFiles.length,
        files: filesToOpen,
      });
    }
  });
  ipcMain.on('windowPositionChange', (event, args) => {
    const targetWindow = getSenderMainWindow(event.sender);
    if (!targetWindow || event.sender.isDestroyed()) return;
    targetWindow.setPosition(...args);
    event.sender.send('windowPositionChange-asyncReply', targetWindow.getPosition());
  });
  ipcMain.on('windowInit', (event) => {
    const targetWindow = getSenderMainWindow(event.sender);
    if (!targetWindow || event.sender.isDestroyed()) return;
    targetWindow.webContents.send('mainCommit', 'windowMinimumSize', targetWindow.getMinimumSize());
    targetWindow.webContents.send('mainCommit', 'windowPosition', targetWindow.getPosition());
    targetWindow.webContents.send('mainCommit', 'isFullScreen', targetWindow.isFullScreen());
    targetWindow.webContents.send('mainCommit', 'isFocused', targetWindow.isFocused());
  });
  ipcMain.on('need-to-restore', () => {
    needToRestore = true;
    markNeedToRestore();
  });
  ipcMain.on('relaunch', () => {
    const switches = process.argv.filter(a => a.startsWith('-'));
    const argv = process.argv.filter(a => !a.startsWith('-'))
      .slice(0, app.isPackaged ? 1 : 2).concat(switches);
    app.relaunch({ args: argv.slice(1), execPath: argv[0] });
    app.quit();
  });
  ipcMain.on('add-preference', createPreferenceWindow);

  ipcMain.on('add-browsing', (e, args) => {
    createBrowsingWindow(args);
  });
  ipcMain.on('clear-history', () => {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('file.clearHistory');
    }
  });
  ipcMain.on('preference-to-main', (e, args) => {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('mainDispatch', 'setPreference', args);
    }
    if (premiumView && !premiumView.webContents.isDestroyed()) {
      premiumView.webContents.send('setPreference', args);
    }
    if (aboutWindow && !aboutWindow.webContents.isDestroyed()) {
      aboutWindow.webContents.send('setPreference', args);
    }
    if (downloadWindow && !downloadWindow.webContents.isDestroyed()) {
      downloadWindow.send('setPreference', args);
    }
    if (downloadListView && !downloadListView.isDestroyed()) {
      downloadListView.webContents.send('setPreference', args);
    }
    if (openUrlWindow && !openUrlWindow.webContents.isDestroyed()) {
      openUrlWindow.webContents.send('setPreference', args);
    }
  });
  ipcMain.on('main-to-preference', (e, args) => {
    if (preferenceWindow && !preferenceWindow.webContents.isDestroyed()) {
      preferenceWindow.webContents.send('preferenceDispatch', 'setPreference', args);
    }
  });
  // OBSOLETE: use app.on below


  ipcMain.on('sign-in-site', async (events, data) => {
    signInSite = data.replace('https', 'http'); // there's a http resource in aliyun afs js sdk
    if (process.env.NODE_ENV === 'production') {
      loginURL = `${signInSite}/static/splayer/login.html`;
      premiumURL = `${signInSite}/static/splayer/premium.html`;
    }
  });

  ipcMain.on('sign-in-end-point', async (events, data) => {
    signInEndpoint = data;
    // applePayVerify update endpoint
    applePayVerify.setEndpoint(data);
    if (process.platform === 'darwin' && !applePayVerifyLock) {
      applePayVerifyLock = true;
      try {
        await applePayVerify.verifyAfterOpenApp();
        if (mainWindow && !mainWindow.webContents.isDestroyed()) {
          mainWindow.webContents.send('payment-success');
        }
      } catch (error) {
        // empty
      }
      applePayVerifyLock = false;
    }
  });

  ipcMain.on('add-payment', (events, data) => {
    createPaymentWindow(data.url, data.orderID, data.channel);
  });

  ipcMain.on('close-payment', () => {
    if (paymentWindow) {
      paymentWindow.close();
      paymentWindow = null;
    }
  });

  ipcMain.on('payment-fail', () => {
    if (premiumView && !premiumView.webContents.isDestroyed()) {
      premiumView.webContents.send('payment-fail', paymentOrigin);
    }
    if (paymentWindow && !paymentWindow.webContents.isDestroyed()) {
      paymentWindowCloseTag = true;
      paymentWindow.close();
      paymentWindow = null;
    }
  });

  ipcMain.on('payment-success', () => {
    if (premiumView && !premiumView.webContents.isDestroyed()) {
      premiumView.webContents.send('payment-success', paymentOrigin);
    }
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('payment-success');
    }
    if (paymentWindow && !paymentWindow.webContents.isDestroyed()) {
      paymentWindowCloseTag = true;
      paymentWindow.close();
      paymentWindow = null;
    }
  });

  ipcMain.on('show-premium-view', (e, route) => {
    createPremiumView(e, route);
    if (preferenceWindow) {
      preferenceWindow.addWebContentsView(premiumView);
      const width = preferenceWindow.getSize()[0];
      const height = preferenceWindow.getSize()[1];
      preferenceWindow.setBounds({
        width,
        height: height + 1,
      });
      preferenceWindow.setBounds({
        width,
        height,
      });
    }
  });

  ipcMain.on('hide-premium-view', () => {
    if (premiumView && preferenceWindow) {
      preferenceWindow.removeWebContentsView(premiumView);
    }
  });

  ipcMain.on('create-order-loading', (e, origin) => {
    paymentOrigin = origin;
    if (preferenceWindow && !preferenceWindow.webContents.isDestroyed()) {
      preferenceWindow.webContents.send('add-payment');
    }
  });

  ipcMain.on('create-order-done', () => {
    if (preferenceWindow && !preferenceWindow.webContents.isDestroyed()) {
      preferenceWindow.webContents.send('close-payment');
    }
  });

  ipcMain.on('close-preference', () => {
    if (preferenceWindow && !preferenceWindow.webContents.isDestroyed()) {
      preferenceWindow.close();
      preferenceWindow = null;
    }
  });
}

function createMainWindow(openDialog, playlistId, requestedFiles) {
  const openRequest = requestedFiles || takeQueuedOpenRequest();
  const playerWindow = new BrowserWindow({
    useContentSize: true,
    frame: false,
    titleBarStyle: 'none',
    width: 720,
    height: 405,
    minWidth: 720,
    minHeight: 405,
    // it can be set true here and be changed during player starting
    transparent: false, // set to false to solve the backdrop-filter bug
    webPreferences: {
      contextIsolation: false,
      webSecurity: false,
      nodeIntegration: true,
      experimentalFeatures: true,
      webviewTag: true,
    },
    // See https://github.com/electron/electron/blob/master/docs/api/browser-window.md#showing-window-gracefully
    backgroundColor: '#000000',
    acceptFirstMouse: false,
    show: false,
    ...({
      win32: {},
    })[process.platform],
  });
  mainWindows.add(playerWindow);
  mainWindow = playerWindow;
  if (
    (!welcomeProcessDone && fs.existsSync(path.join(userDataPath, 'WELCOME_PROCESS_MARK')))
    || welcomeProcessDone
  ) {
    welcomeProcessDone = true;
    openRequest.videoFiles.length
      ? playerWindow.loadURL(`${mainURL}#/play`) : playerWindow.loadURL(mainURL);
  } else {
    playerWindow.loadURL(`${mainURL}#/welcome`);
  }
  playerWindow.webContents.userAgent = `${playerWindow.webContents.userAgent.replace(/Electron\S+/i, '')} SPlayerX@2018 Platform/${os.platform()} Release/${os.release()} Version/${app.getVersion()} EnvironmentName/${environmentName}`;
  menuService?.setMainWindow(playerWindow);

  playerWindow.on('closed', () => {
    mainWindows.delete(playerWindow);
    if (mainWindow === playerWindow) {
      mainWindow = Array.from(mainWindows).reverse().find(isUsableMainWindow) || null;
      if (mainWindow) {
        // macOS does not consistently emit a new focus event when the front
        // window closes, so explicitly restore the newly exposed window menu.
        setImmediate(() => restoreMainWindowMenu(mainWindow));
      } else menuService?.setMainWindow(null);
    }
  });

  playerWindow.once('ready-to-show', () => {
    playerWindow.show();
    setActiveMainWindow(playerWindow);
    sendOpenRequest(playerWindow, openRequest);
    if (openDialog) playerWindow.webContents.send('open-dialog', playlistId);
  });

  registerMainWindowEvent(playerWindow);

  if (process.env.NODE_ENV === 'development') {
    setTimeout(() => { // wait some time to prevent `Object not found` error
      if (isUsableMainWindow(playerWindow)) playerWindow.openDevTools({ mode: 'detach' });
    }, 1000);
  }
  playerWindow.on('focus', () => {
    menuService?.enableMenu(true);
  });
  return playerWindow;
}

['left-drag', 'left-up'].forEach((channel) => {
  mouse.on(channel, (...args) => {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    if (!focusedWindow || focusedWindow.webContents.isDestroyed()) return;
    if (focusedWindow.isMaximized()) return;
    if (process.platform === 'darwin' && focusedWindow !== browsingWindow) return;
    focusedWindow.send(`mouse-${channel}`, ...args);
  });
});

app.on('before-quit', () => {
  // Do not leave the TV playing and the HTTP server bound after we exit.
  castService.stopBackgroundDiscovery();
  castService.stop();
  losslessStreamingInstance.dispose();
  if (downloadWindow) downloadWindow.webContents.send('quit');
  if (needToRestore) {
    broadcastToMainWindows('quit', needToRestore);
  } else {
    broadcastToMainWindows('quit');
  }
});

app.on('quit', () => {
  mouse.dispose();
});

app.on('minimize', () => {
  const targetWindow = getActiveMainWindow();
  if (targetWindow && targetWindow.isFocused()) {
    targetWindow.minimize();
  }
});

async function darwinOpenFilesToStart() {
  if (!app.isReady()) return;
  const request = takeQueuedOpenRequest();
  if (!request.videoFiles.length && !request.subtitleFiles.length) return;
  const targetWindow = getActiveMainWindow();
  if (request.videoFiles.length || !targetWindow) {
    createMainWindow(false, undefined, request);
    return;
  }
  sendOpenRequest(targetWindow, request, true);
  if (!targetWindow.isVisible()) targetWindow.show();
  if (targetWindow.isMinimized()) targetWindow.restore();
  targetWindow.focus();
}
const darwinOpenFilesToStartDebounced = debounce(darwinOpenFilesToStart, 100);
if (process.platform === 'darwin') {
  app.on('will-finish-launching', () => {
    app.on('open-file', (event, file) => {
      event.preventDefault();
      collectOpenPath(file, tmpVideoToOpen, tmpSubsToOpen);
      darwinOpenFilesToStartDebounced();
    });
  });
} else {
  const tmpFile = process.argv.slice(app.isPackaged ? 1 : 2);
  tmpFile.forEach(file => collectOpenPath(file, tmpVideoToOpen, tmpSubsToOpen));
}

app.on('second-instance', (event, argv) => {
  if (!app.isReady()) return;
  const videoFiles = [];
  const subtitleFiles = [];
  argv.slice(app.isPackaged ? 1 : 2)
    .forEach(file => collectOpenPath(file, videoFiles, subtitleFiles));
  createMainWindow(false, undefined, createOpenRequest(videoFiles, subtitleFiles));
});

app.on('ready', () => {
  menuService = new MenuService();
  if (process.platform === 'darwin') {
    systemPreferences.subscribeNotification('AppleInterfaceThemeChangedNotification', () => {
      if (routeName === 'browsing-view') {
        menuService?.updatePipIcon();
      }
    });
    systemPreferences.setUserDefault('NSDisabledDictationMenuItem', 'boolean', true);
    systemPreferences.setUserDefault('NSDisabledCharacterPaletteMenuItem', 'boolean', true);
  }
  createMainWindow();
  app.name = 'SPlayer';
  globalShortcut.register('CmdOrCtrl+Shift+I+O+P', () => {
    if (mainWindow) mainWindow.openDevTools({ mode: 'detach' });
  });
  globalShortcut.register('CmdOrCtrl+Shift+J+K+L', () => {
    if (preferenceWindow) preferenceWindow.openDevTools({ mode: 'detach' });
  });
  globalShortcut.register('CmdOrCtrl+Shift+Q+W+E', () => {
    if (premiumView) premiumView.webContents.openDevTools();
  });
  globalShortcut.register('CmdOrCtrl+Shift+Z+X+C', () => {
    if (paymentWindow) paymentWindow.openDevTools({ mode: 'detach' });
  });

  if (process.platform === 'win32') {
    globalShortcut.register('CmdOrCtrl+`', () => {
      handleBossKey();
    });
  }
});

app.on('window-all-closed', () => {
  if (
    (routeName === 'welcome-privacy' || routeName === 'language-setting')
    || process.platform !== 'darwin') {
    app.quit();
  }
});

const oauthRegex = [
  /^https:\/\/cnpassport.youku.com\//i,
  /^https:\/\/udb3lgn.huya.com\//i,
  /^https:\/\/passport.iqiyi.com\/apis\/thirdparty/i,
  /^https:\/\/api.weibo.com\/oauth2/i,
  /^https:\/\/graph.qq.com\//i,
  /^https:\/\/open.weixin.qq.com\//i,
  /^https:\/\/openapi.baidu.com\//i,
  /^https:\/\/auth.alipay.com\/login\//i,
  /^https:\/\/account.xiaomi.com\/pass\//i,
  /^https:\/\/www.facebook.com\/v[0-9].[0-9]\/dialog\/oauth/i,
  /^https:\/\/accounts.google.com\/signin\/oauth\//i,
  /^https:\/\/accounts.google.com\/CheckCookie\?/i,
  /^\/passport\/user\/tplogin\?/i,
  /^https:\/\/www.imooc.com\/passport\//i,
];
app.on('web-contents-created', (webContentsCreatedEvent, contents) => {
  if (contents.getType() === 'browserView') {
    contents.setWindowOpenHandler(({ url }) => ({
      action: oauthRegex.some(re => re.test(url)) ? 'allow' : 'deny',
    }));
  }
});

app.on('bossKey', handleBossKey);
app.on('add-preference', createPreferenceWindow);
app.on('add-window-about', createAboutWindow);
app.on('add-window-losslessStreaming', createLosslessStreamingWindow);
app.on('new-main-window', () => createMainWindow());
app.on('open-history-item', (evt, args) => {
  openHistoryItem(evt, args);
  mainWindow.send('update-current-channel', args.channel);
});

app.on('menu-create-main-window', () => {
  if (!mainWindow) createMainWindow();
  else if (mainWindow.isMinimized()) {
    mainWindow.restore();
  } else if (!mainWindow.isVisible() && (!browsingWindow || !browsingWindow.isVisible())) {
    mainWindow.show();
  }
});

app.on('menu-open-dialog', (playlistId) => {
  createMainWindow(true, playlistId);
});

app.on('activate', () => {
  if (!mainWindow) {
    if (app.isReady()) createMainWindow();
  } else if (!mainWindow.isVisible() && (!browsingWindow || !browsingWindow.isVisible())) {
    mainWindow.show();
  }
  if (browsingWindow && browsingWindow.isMinimized()) {
    browsingWindow.restore();
  }
  if (mainWindow && mainWindow.isMinimized()) {
    mainWindow.restore();
  }
});

app.on('refresh-token', async (account) => {
  global['account'] = account;
  menuService?.updateAccount(account);
  saveToken(account.token);
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('sign-in', account);
  }
  if (preferenceWindow && !preferenceWindow.webContents.isDestroyed()) {
    preferenceWindow.webContents.send('sign-in', account);
  }
  if (premiumView && !premiumView.webContents.isDestroyed()) {
    premiumView.webContents.send('sign-in', account);
  }
  if (paymentWindow && !paymentWindow.webContents.isDestroyed()) {
    paymentWindow.webContents.send('sign-in', account);
  }
});


app.on('sign-in', async () => { // eslint-disable-line complexity
  // if applePayVerify is waiting for sign in handle
  if (!applePayVerifyLock && applePayVerify.isWaitingSignIn()) {
    applePayVerifyLock = true;
    try {
      const success = await applePayVerify.verifyAfterSignIn();
      if (premiumView && !premiumView.webContents.isDestroyed() && success) {
        // notify web handle success
        premiumView.webContents.send('applePay-success', paymentOrigin);
      }
      if (mainWindow && !mainWindow.webContents.isDestroyed() && success) {
        mainWindow.webContents.send('payment-success');
      }
    } catch (error) {
      if (premiumView && !premiumView.webContents.isDestroyed()) {
        premiumView.webContents.send('applePay-fail', paymentOrigin, error);
      }
    }
    applePayVerifyLock = false;
  } else if (!applePayVerifyLock) {
    applePayVerifyLock = true;
    try {
      await applePayVerify.verifyAfterOpenApp();
      if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('payment-success');
      }
    } catch (error) {
      // empty
    }
    applePayVerifyLock = false;
  }
});

app.on('sign-out-confirm', () => {
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('sign-out-confirm', undefined);
  }
});

app.on('sign-out', () => {
  global['account'] = undefined;
  menuService?.updateAccount(undefined);
  saveToken('');
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('sign-in', undefined);
  }
  if (preferenceWindow && !preferenceWindow.webContents.isDestroyed()) {
    preferenceWindow.webContents.send('sign-in', undefined);
  }
  if (premiumView && !premiumView.webContents.isDestroyed()) {
    premiumView.webContents.send('sign-in', undefined);
  }
  if (paymentWindow && !paymentWindow.webContents.isDestroyed()) {
    paymentWindow.webContents.send('sign-in', undefined);
  }
});


app.on('losslessStreaming-select', (src) => {
  losslessStreamingInstance.start(src);
});
app.on('losslessStreaming-stop', () => {
  losslessStreamingInstance.stop();
});
app.on('losslessStreaming-info-update', (info, prevInfo) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('losslessStreaming-info-update', info, prevInfo);
  }
  if (!info.enabled) {
    if (losslessStreamingWindow) {
      losslessStreamingWindow.close();
      losslessStreamingWindow = null;
    }
  }
  app.emit('losslessStreaming-menu-update', info);
  if (prevInfo && !prevInfo.enabled && info.enabled) app.emit('add-window-losslessStreaming');
});
app.on('losslessStreaming-menu-update', (info) => {
  info = info || losslessStreamingInstance.getInfo();
  menuService?.updateMenuItemEnabled('file.losslessStreaming.getInfo', info.enabled);
  menuService?.updateMenuItemEnabled('file.losslessStreaming.stop', info.enabled);
});

app.getDisplayLanguage = () => {
  locale.refreshDisplayLanguage();
  return locale.displayLanguage;
};

// export getIp to static login preload.js
app.getIP = getIP;

app.crossThreadCache = crossThreadCache;

// export endpoints to static login preload.js
app.getSignInEndPoint = () => signInEndpoint;
app.getSignInSite = () => signInSite;

// apple pay
if (process.platform === 'darwin') {
  // Listen for transactions as soon as possible.
  inAppPurchase.on('transactions-updated', (event, transactions) => {
    if (!Array.isArray(transactions)) {
      return;
    }
    // Check each transaction.
    transactions.forEach(async (transaction) => { // eslint-disable-line complexity
      // const payment = transaction.payment;
      switch (transaction.transactionState) {
        case 'purchasing':
          break;
        case 'purchased':
          // eslint-disable-next-line no-case-declarations
          let receipt;
          try {
            receipt = fs.readFileSync(inAppPurchase.getReceiptURL());
          } catch (error) {
            // empty
          }
          try {
            const verifySuccess = await applePayVerify.verifyAfterPay({
              date: transaction.transactionDate,
              payment: {
                transactionID: transaction.transactionIdentifier,
                productID: applePayProductID,
                receipt: receipt.toString('base64'),
                currency: applePayCurrency,
              },
            });
            if (premiumView && !premiumView.webContents.isDestroyed() && verifySuccess) {
              // notify web handle success
              premiumView.webContents.send('applePay-success', paymentOrigin);
            }
            if (mainWindow && !mainWindow.webContents.isDestroyed() && verifySuccess) {
              mainWindow.webContents.send('payment-success');
            }
          } catch (error) {
            if (premiumView && !premiumView.webContents.isDestroyed()) {
              premiumView.webContents.send('applePay-fail', paymentOrigin, error);
            }
          }
          break;
        case 'failed':
          // Finish the transaction.
          inAppPurchase.finishTransactionByDate(transaction.transactionDate);
          if (premiumView && !premiumView.webContents.isDestroyed()) {
            premiumView.webContents.send('applePay-fail', paymentOrigin, 'not support');
          }
          break;
        case 'restored':
          break;
        case 'deferred':
          break;
        default:
          break;
      }
    });
  });

  // apple pay
  app.applePay = (product, id, currency, quantity, callback) => {
    applePayProductID = id;
    applePayCurrency = currency;
    // Check if the user is allowed to make in-app purchase.
    if (!inAppPurchase.canMakePayments()) {
      if (premiumView && !premiumView.webContents.isDestroyed()) {
        premiumView.webContents.send('applePay-fail', paymentOrigin, 'not support');
      }
      return;
    }
    // Retrieve and display the product descriptions.
    inAppPurchase.getProducts([product]).then((products) => {
      // Check the parameters.
      if (!Array.isArray(products) || products.length <= 0) {
        if (premiumView && !premiumView.webContents.isDestroyed()) {
          premiumView.webContents.send('applePay-fail', paymentOrigin, 'Unable to retrieve the product informations.');
        }
        return;
      }
      // Purchase the selected product.
      inAppPurchase.purchaseProduct(product, quantity).then(callback, (err) => {
        console.error(err);
      });
    }, (err) => {
      console.error(err);
    });
  };
}

/** Casting: the renderer owns the file path and the AI cues, main owns the
 *  device session, so the menu asks the renderer and the renderer calls back. */
app.on('cast-to-device', () => {
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('cast-request');
  }
});

// The on-screen cast button emits this on the app; forward it to the window.
app.on('cast-request', () => {
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('cast-request');
  }
});

// Warm the list in the background so the picker opens instantly.
app.on('ready', () => castService.startBackgroundDiscovery());

ipcMain.handle('cast-list-devices', async () => castService.listDevices());

castService.on('status', (status) => {
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('cast-status', status);
  }
});

ipcMain.handle('cast-start', async (e, {
  device, filePath, cues, currentTime, volume,
}) => {
  try {
    await castService.cast(
      device, filePath, cues || [], currentTime || 0,
      typeof volume === 'number' ? volume : 1,
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
});

ipcMain.on('cast-stop', () => castService.stop());
ipcMain.on('cast-pause', () => castService.pause());
ipcMain.on('cast-play', () => castService.play());
ipcMain.on('cast-seek', (e, seconds) => castService.seek(seconds));
ipcMain.on('cast-volume', (e, level) => castService.setVolume(level));
