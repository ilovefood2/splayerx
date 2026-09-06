import path from 'path';
import fs, { promises as fsPromises } from 'fs';
import FakeTimers from '@sinonjs/fake-timers';
import { get } from 'lodash';
import { mediaQuickHash } from '@/libs/utils';
import bookmark from '@/helpers/bookmark';
import syncStorage from '@/helpers/syncStorage';
import infoDB from '@/helpers/infoDB';
import { log } from '@/libs/Log';
import {
  getAllValidExtensions,
  isSubtitle,
  isVideo,
  isAudio,
  isImage,
  isValidFile,
} from '@/../shared/utils';
import {
  EMPTY_FOLDER, OPEN_FAILED, ADD_NO_VIDEO,
  SNAPSHOT_FAILED, SNAPSHOT_SUCCESS, FILE_NON_EXIST_IN_PLAYLIST, PLAYLIST_NON_EXIST,
  THUMBNAIL_GENERATE_FAILED, THUMBNAIL_GENERATE_SUCCESS,
} from '@/helpers/notificationcodes';

import { ipcRenderer, remote } from 'electron'; // eslint-disable-line
import sortVideoFile from '@/helpers/sort';
import { addBubble } from './notificationControl';

const clock = FakeTimers.createClock();

async function expandInputPath(inputPath, assumeDirectory, recurse) {
  if (path.basename(inputPath).startsWith('.')) return [];

  let isDirectory = assumeDirectory;
  if (!assumeDirectory) {
    try {
      isDirectory = (await fsPromises.stat(inputPath)).isDirectory();
    } catch (error) {
      return []; // unreadable path — skip rather than throw
    }
  }
  if (!isDirectory) return [inputPath];

  let entries;
  try {
    entries = await fsPromises.readdir(inputPath, { withFileTypes: true });
  } catch (error) {
    // assumeDirectory was wrong (a file slipped in) or the directory is
    // unreadable; drop it instead of rejecting the whole open.
    return [];
  }
  const groups = await Promise.all(entries.map((entry) => {
    if (entry.name.startsWith('.')) return [];
    const childPath = path.join(inputPath, entry.name);
    // Reuse the dirent type so recursive folder scans do not stat every child.
    if (entry.isDirectory()) return recurse ? expandInputPath(childPath, true, recurse) : [];
    return [childPath];
  }));
  return groups.flat();
}

async function expandInputPaths(inputPaths, { assumeDirectories = false, recurse = false } = {}) {
  const pathGroups = await Promise.all(
    inputPaths.map(inputPath => expandInputPath(inputPath, assumeDirectories, recurse)),
  );
  return pathGroups.flat();
}

export default {
  data() {
    return {
      clock,
      infoDB,
      showingPopupDialog: false,
      access: [],
    };
  },
  methods: {
    timecodeFromSeconds(s) {
      const dt = new Date(Math.abs(s) * 1000);
      let hours = dt.getUTCHours();
      let minutes = dt.getUTCMinutes();
      let seconds = dt.getUTCSeconds();

      // the above dt.get...() functions return a single digit
      // so I prepend the zero here when needed
      if (minutes < 10) {
        minutes = `0${minutes}`;
      }
      if (seconds < 10) {
        seconds = `0${seconds}`;
      }
      if (hours > 0) {
        if (hours < 10) {
          hours = `${hours}`;
        }
        return `${hours}:${minutes}:${seconds}`;
      }
      return `${minutes}:${seconds}`;
    },
    async findSimilarVideoByVidPath(vidPath) {
      vidPath = decodeURI(vidPath);

      if (process.platform === 'win32') {
        vidPath = vidPath.replace(/^file:\/\/\//, '');
      } else {
        vidPath = vidPath.replace(/^file:\/\//, '');
      }

      const dirPath = path.dirname(vidPath);

      // Continue a folder queue through nested folders without an lstat for
      // each child. This is what lets an image/video sequence flow from one
      // subfolder into the next.
      const videoFiles = (await expandInputPath(dirPath, true, true))
        .filter(file => isVideo(file) || isImage(file)); // TODO: audio
      videoFiles.sort(sortVideoFile);

      return videoFiles;
    },
    openFilesByDialog({ defaultPath } = {}) {
      if (this.showingPopupDialog) return;
      this.showingPopupDialog = true;
      const opts = ['openFile', 'multiSelections'];
      if (process.platform === 'darwin') {
        opts.push('openDirectory');
      }
      process.env.NODE_ENV === 'testing' ? '' : remote.dialog.showOpenDialog({
        title: 'Open Dialog',
        defaultPath,
        filters: [{
          name: 'Media Files',
          extensions: getAllValidExtensions(),
        }, {
          name: 'All Files',
          extensions: ['*'],
        }],
        properties: opts,
        securityScopedBookmarks: process.mas,
      }).then(async ({ filePaths, bookmarks }) => {
        this.showingPopupDialog = false;
        if (process.mas && get(bookmarks, 'length') > 0) {
          // TODO: put bookmarks to database
          bookmark.resolveBookmarks(filePaths, bookmarks);
        }
        if (filePaths && filePaths.length) {
          this.$store.commit('source', '');
          // if selected files contain folders only, then call openFolder()
          const pathStats = await Promise.all(filePaths.map(file => fsPromises.stat(file)));
          const onlyFolders = pathStats.every(stats => stats.isDirectory());
          filePaths.forEach(file => remote.app.addRecentDocument(file));
          if (onlyFolders) {
            this.openFolder(...filePaths);
          } else {
            this.openFile(...filePaths);
          }
        }
      }).catch((error) => {
        this.showingPopupDialog = false;
        log.error('openFilesByDialog', error);
      });
    },
    addFilesByDialog({ defaultPath } = {}) {
      if (this.showingPopupDialog) return Promise.resolve();
      this.showingPopupDialog = true;
      const opts = ['openFile', 'multiSelections'];
      if (process.platform === 'darwin') {
        opts.push('openDirectory');
      }
      return new Promise((resolve) => {
        process.env.NODE_ENV === 'testing' ? '' : remote.dialog.showOpenDialog({
          title: 'Open Dialog',
          defaultPath,
          filters: [{
            name: 'Media Files',
            extensions: getAllValidExtensions(),
          }, {
            name: 'All Files',
            extensions: ['*'],
          }],
          properties: opts,
          securityScopedBookmarks: process.mas,
        }).then(({ filePaths, bookmarks }) => {
          this.showingPopupDialog = false;
          if (process.mas && get(bookmarks, 'length') > 0) {
            // TODO: put bookmarks to database
            bookmark.resolveBookmarks(filePaths, bookmarks);
          }
          if (filePaths && filePaths.length) {
            this.addFiles(...filePaths).then(() => {
              resolve();
            });
          }
        }).catch((error) => {
          this.showingPopupDialog = false;
          log.error('addFilesByDialog', error);
        });
      });
    },
    chooseThumbnailFolder(defaultName, data) {
      if (this.showingPopupDialog) return;
      this.showingPopupDialog = true;
      process.env.NODE_ENV === 'testing' ? '' : remote.dialog.showOpenDialog({
        title: 'Snapshot Save',
        defaultPath: data.defaultFolder ? data.defaultFolder : remote.app.getPath('desktop'),
        filters: [{
          name: 'Thumbnail',
        }, {
          name: 'All Files',
        }],
        properties: ['openDirectory'],
        securityScopedBookmarks: process.mas,
      }, (files, bookmarks) => {
        if (files) {
          fs.writeFile(path.join(files[0], data.name), data.buffer, (error) => {
            if (error) {
              addBubble(THUMBNAIL_GENERATE_FAILED, { id: defaultName });
            } else {
              this.$store.dispatch('UPDATE_SNAPSHOT_SAVED_PATH', files[0]);
              addBubble(THUMBNAIL_GENERATE_SUCCESS, {
                snapshotPath: path.join(files[0], data.name), id: defaultName,
              });
            }
          });
        }
        this.showingPopupDialog = false;
        if (process.mas && get(bookmarks, 'length') > 0) {
          // TODO: put bookmarks to database
          bookmark.resolveBookmarks(files, bookmarks);
        }
      });
    },
    chooseSnapshotFolder(defaultName, data) {
      if (this.showingPopupDialog) return;
      this.showingPopupDialog = true;
      process.env.NODE_ENV === 'testing' ? '' : remote.dialog.showOpenDialog({
        title: 'Snapshot Save',
        defaultPath: data.defaultFolder ? data.defaultFolder : remote.app.getPath('desktop'),
        filters: [{
          name: 'Snapshot',
        }, {
          name: 'All Files',
        }],
        properties: ['openDirectory'],
        securityScopedBookmarks: process.mas,
      }).then(({ filePaths, bookmarks }) => {
        if (filePaths && filePaths.length) {
          fs.writeFile(path.join(filePaths[0], data.name), data.buffer, (error) => {
            if (error) {
              addBubble(SNAPSHOT_FAILED, { id: defaultName });
            } else {
              this.$store.dispatch('UPDATE_SNAPSHOT_SAVED_PATH', filePaths[0]);
              addBubble(SNAPSHOT_SUCCESS, {
                snapshotPath: path.join(filePaths[0], data.name), id: defaultName,
              });
            }
          });
        }
        this.showingPopupDialog = false;
        if (process.mas && get(bookmarks, 'length') > 0) {
          // TODO: put bookmarks to database
          bookmark.resolveBookmarks(filePaths, bookmarks);
        }
      }).catch((error) => {
        this.showingPopupDialog = false;
        log.error('chooseSnapshotFolder', error);
      });
    },
    async addFiles(...files) { // eslint-disable-line complexity
      const videoFiles = [];
      files = await expandInputPaths(files, { recurse: true });

      for (let i = 0; i < files.length; i += 1) {
        const file = files[i];
        if (!path.basename(file).startsWith('.')
          && (isVideo(file) || isAudio(file) || isImage(file))) {
          videoFiles.push(file);
        }
      }
      if (videoFiles.length !== 0) {
        const addFiles = videoFiles.filter(file => !this.$store.getters.playingList.includes(file));
        if (this.$store.getters.isFolderList || this.$store.getters.incognitoMode) {
          await this.$store.dispatch('FolderList', {
            id: this.playListId,
            paths: [...this.$store.getters.playingList, ...addFiles],
          });
          return;
        }
        const playlist = await this.infoDB.get('recent-played', this.playListId);
        const addIds = [];
        for (const videoPath of addFiles) {
          const quickHash = await mediaQuickHash.try(videoPath);
          if (quickHash) {
            const data = {
              quickHash,
              type: 'video',
              path: videoPath,
              source: 'playlist',
            };
            const videoId = await this.infoDB.add('media-item', data);
            addIds.push(videoId);
            playlist.items.push(videoId);
            playlist.hpaths.push(`${quickHash}-${videoPath}`);
          }
        }
        this.$store.dispatch('AddItemsToPlayingList', {
          paths: addFiles,
          ids: addIds,
        });
        this.infoDB.update('recent-played', playlist, playlist.id);
        this.$store.dispatch('PlayingList', { id: playlist.id });
      } else {
        log.error('helpers/index.js', 'Didn\'t add any playable file in this folder.');
        addBubble(ADD_NO_VIDEO);
      }
    },
    // the difference between openFolder and openFile function
    // is the way they treat the situation of empty folders and error files
    async openFolder(...folders) {
      let containsSubFiles = false;
      const subtitleFiles = [];
      const videoFiles = [];
      const files = await expandInputPaths(
        folders, { assumeDirectories: true, recurse: true },
      );

      for (let i = 0; i < files.length; i += 1) {
        const file = files[i];
        if (!path.basename(file).startsWith('.')) {
          if (isSubtitle((file))) {
            subtitleFiles.push({ src: file, type: 'local' });
            containsSubFiles = true;
          } else if (isValidFile((file))) {
            videoFiles.push(file);
          }
        }
      }
      videoFiles.sort(sortVideoFile);
      if (videoFiles.length !== 0) {
        await this.createPlayList(...videoFiles);
      } else {
        log.warn('helpers/index.js', 'There is no playable file in this folder.');
        addBubble(EMPTY_FOLDER);
      }
      if (containsSubFiles) {
        this.$bus.$emit('add-subtitles', subtitleFiles);
      }
    },
    // filter video and sub files
    async openFile(...files) {
      try {
        let containsSubFiles = false;
        const subtitleFiles = [];
        const videoFiles = [];
        files = await expandInputPaths(files, { recurse: true });

        files.forEach((tempFilePath) => {
          const baseName = path.basename(tempFilePath);
          if (baseName.startsWith('.')) return;
          if (isSubtitle((tempFilePath))) {
            subtitleFiles.push({ src: tempFilePath, type: 'local' });
            containsSubFiles = true;
          } else if (isValidFile((tempFilePath))) {
            videoFiles.push(tempFilePath);
          } else {
            log.warn('helpers/index.js', `Failed to open file : ${tempFilePath}`);
            addBubble(OPEN_FAILED);
          }
        });

        if (videoFiles.length > 1) {
          await this.createPlayList(...videoFiles);
        } else if (videoFiles.length === 1) {
          await this.openVideoFile(...videoFiles);
        }
        if (containsSubFiles) {
          this.$bus.$emit('add-subtitles', subtitleFiles);
        }
      } catch (ex) {
        log.info('openFile', ex);
        addBubble(OPEN_FAILED);
      }
    },
    // open an existed play list
    async openPlayList(id) {
      const playlist = await this.infoDB.get('recent-played', id);
      if (!playlist) return;
      if (!this.$store.getters.incognitoMode) await this.infoDB.update('recent-played', { ...playlist, lastOpened: Date.now() }, playlist.id);
      if (playlist.items.length > 1) {
        let currentVideo = await this.infoDB.get('media-item', playlist.items[playlist.playedIndex]);

        const deleteItems = [];
        await Promise.all(playlist.items.map(async (item) => {
          const video = await this.infoDB.get('media-item', item);
          try {
            await fsPromises.access(video.path, fs.constants.F_OK);
          } catch (err) {
            deleteItems.push(item);
            // this.infoDB.delete('media-item', video.videoId);
          }
        }));
        if (deleteItems.length > 0) {
          deleteItems.forEach((id) => {
            const index = playlist.items.findIndex(videoId => videoId === id);
            playlist.items.splice(index, 1);
          });
          if (playlist.items.length > 0) {
            playlist.playedIndex = 0;
            await this.infoDB.update('recent-played', playlist, playlist.id);
            currentVideo = await this.infoDB.get('media-item', playlist.items[0]);
            addBubble(FILE_NON_EXIST_IN_PLAYLIST);
          } else {
            addBubble(PLAYLIST_NON_EXIST);
            return;
          }
        }

        await this.playFile(currentVideo.path, currentVideo.videoId, currentVideo.quickHash);
        const paths = [];
        for (const videoId of playlist.items) {
          // TODO: find out why videoId is undefined
          if (!videoId) continue; // eslint-disable-line
          const mediaItem = await this.infoDB.get('media-item', videoId);
          paths.push(mediaItem.path);
        }
        this.$store.dispatch('PlayingList', {
          id,
          paths,
          items: playlist.items,
        });
        this.$bus.$emit('open-playlist');
      } else {
        const video = await this.infoDB.get('media-item', playlist.items[playlist.playedIndex]);
        try {
          await fsPromises.access(video.path, fs.constants.F_OK);
          this.$store.dispatch('FolderList', {
            id,
            paths: [video.path],
            items: [playlist.items[0]],
          });
          this.playFile(video.path, video.videoId, video.quickHash);
        } catch (err) {
          addBubble(PLAYLIST_NON_EXIST);
        }
      }
    },
    // create new play list record in recent-played and play the video
    async createPlayList(...videoFiles) {
      // Videos on a mounted / network volume must NOT be hashed a whole folder at
      // a time: mediaQuickHash reads near the end of each file, forcing a far-seek
      // over SMB, and doing that for every file in the folder starves the video
      // being played (the app freezes and seeking stops working). Play the first
      // file straight away and let each file be fingerprinted lazily when it is
      // actually opened (openVideoFile), keeping the folder's paths for the
      // playlist panel and next/previous navigation.
      const isMounted = videoFiles[0].startsWith('/Volumes/') || /^\\\\/.test(videoFiles[0]);
      if (isMounted || this.$store.getters.incognitoMode) {
        this.$store.dispatch('FolderList', { id: '', paths: videoFiles, items: [] });
        await this.openVideoFile(videoFiles[0], { keepCurrentFolderList: true });
        this.$bus.$emit('open-playlist');
        this.$bus.$emit('new-playlist');
        return undefined;
      }
      const hash = await mediaQuickHash.try(videoFiles[0]);
      if (!hash) return;
      // Resolve the first video's existing media-item up front (if it was played
      // before) so resume-to-last-position works immediately, rather than only
      // after the whole folder finishes indexing in the background. NaN otherwise,
      // which onMetaLoaded reads as "no saved position".
      const knownVideo = this.$store.getters.incognitoMode
        ? null
        : await this.infoDB.get('media-item', 'path', videoFiles[0]);
      const firstId = knownVideo && knownVideo.quickHash === hash ? knownVideo.videoId : NaN;
      this.$store.dispatch('PlayingList', { id: '', paths: videoFiles, items: [] });
      this.$store.dispatch('SRC_SET', { src: videoFiles[0], id: firstId, mediaHash: hash });
      if (this.$router.currentRoute.value.name !== 'playing-view') {
        this.$router.push({ name: 'playing-view' });
      }
      this.$bus.$emit('new-file-open');

      // Only the first item is needed to start playback. Index the rest in the
      // background so large SMB/NFS folders do not hold the player on the landing page.
      this.infoDB.addPlaylist(videoFiles, { [videoFiles[0]]: hash })
        .then(async (id) => {
          const playlistItem = await this.infoDB.get('recent-played', id);
          if (!playlistItem || !this.$store.getters.playingList.includes(videoFiles[0])) return;
          this.$store.dispatch('PlayingList', {
            id,
            paths: videoFiles,
            items: playlistItem.items,
          });
          // Match the currently-playing file by path, not position: videos whose
          // quickHash failed are skipped, so items[] can be shorter than and
          // misaligned with videoFiles, which would otherwise assign a wrong id.
          const currentSrc = this.$store.getters.originSrc;
          const currentIndex = (playlistItem.hpaths || [])
            .findIndex(hpath => hpath.endsWith(`-${currentSrc}`));
          if (currentIndex >= 0 && playlistItem.items[currentIndex]) {
            this.$store.commit('ID_UPDATE', playlistItem.items[currentIndex]);
          }
          this.$bus.$emit('open-playlist');
          this.$bus.$emit('new-playlist');
        })
        .catch(ex => log.error('createPlayList', ex));
      return hash;
    },
    async openUrlFile(url) {
      const id = await this.infoDB.addPlaylist([url]);
      const playlistItem = await this.infoDB.get('recent-played', id);
      this.playFile(url, playlistItem.items[playlistItem.playedIndex]);
      this.$store.dispatch('FolderList', {
        id,
        paths: [url],
        items: [id],
      });
    },
    // open single video
    async openVideoFile(videoFile, options = {}) {
      if (!videoFile) return;
      const incognito = this.$store.getters.incognitoMode;
      let id;
      let playlist;
      if (!options.keepCurrentFolderList) {
        this.$store.dispatch('FolderList', {
          id: '',
          paths: [videoFile],
          items: [],
        });
      }
      const knownVideoPromise = incognito
        ? Promise.resolve(null)
        : this.infoDB.get('media-item', 'path', videoFile).then((knownVideo) => {
          if (knownVideo && this.$store.getters.originSrc === videoFile) {
            this.$store.commit('ID_UPDATE', knownVideo.videoId);
          }
          return knownVideo;
        });
      const [quickHash, knownVideo] = await Promise.all([
        this.playFile(videoFile, NaN),
        knownVideoPromise,
      ]);
      // Private folder playback stays in memory, including when a slow hash
      // finishes after the player has already closed or switched files.
      if (!quickHash || incognito || this.$store.getters.incognitoMode
        || this.$store.getters.originSrc !== videoFile) return;
      playlist = await this.infoDB.get('recent-played', 'hpaths', [`${quickHash}-${videoFile}`]);
      if (quickHash && playlist && !this.$store.getters.incognitoMode) {
        id = playlist.id;
        playlist.lastOpened = Date.now();
        this.infoDB.update('recent-played', playlist, playlist.id);
      } else if (quickHash) {
        playlist = {
          items: [],
          hpaths: [],
          playedIndex: 0,
          lastOpened: Date.now(),
        };
        const data = {
          quickHash,
          type: 'video',
          path: videoFile,
          source: '',
        };
        const videoId = knownVideo && knownVideo.quickHash === quickHash
          ? knownVideo.videoId
          : await this.infoDB.add('media-item', data);
        playlist.items.push(videoId);
        playlist.hpaths.push(`${quickHash}-${videoFile}`);
        id = await this.infoDB.add('recent-played', playlist);
      }

      if (!quickHash || !playlist) return;
      if (this.$store.getters.originSrc === videoFile) {
        this.$store.commit('ID_UPDATE', playlist.items[0]);
        const paths = this.$store.getters.playingList;
        this.$store.dispatch('FolderList', {
          id,
          paths,
          items: paths.map((file, index) => (file === videoFile
            ? playlist.items[0] : this.$store.getters.items[index])),
        });
      }
    },
    bookmarkAccessing(vidPath) {
      const bookmarkObj = syncStorage.getSync('bookmark');
      if (Object.prototype.hasOwnProperty.call(bookmarkObj, vidPath)) {
        const { app } = remote;
        const bookmark = bookmarkObj[vidPath];
        let stopAccessing;
        try {
          stopAccessing = app.startAccessingSecurityScopedResource(bookmark);
        } catch (ex) {
          log.warn(`startAccessingSecurityScopedResource ${bookmark}`, ex);
          addBubble(OPEN_FAILED);
          return false;
        }
        this.access.push({
          src: vidPath,
          stopAccessing,
        });
        this.$bus.$once(`stop-accessing-${vidPath}`, (e) => {
          get(this.access.find(item => item.src === e), 'stopAccessing')();
          const index = this.access.findIndex(item => item.src === e);
          if (index >= 0) this.access.splice(index, 1);
        });
      }
      return true;
    },
    // openFile and db operation
    async playFile(vidPath, id, knownMediaHash) { // eslint-disable-line complexity
      if (process.mas && this.$store.getters.source !== 'drop') {
        if (!this.bookmarkAccessing(vidPath)) return undefined;
      }
      if (this.$store.getters.showSidebar) {
        this.$store.dispatch('UPDATE_SHOW_SIDEBAR', false);
      }
      const sourceTask = this.$store.dispatch('SRC_SET', {
        src: vidPath,
        mediaHash: knownMediaHash,
        id,
      });
      if (this.$router.currentRoute.value.name !== 'playing-view') {
        this.$router.push({ name: 'playing-view' });
      }
      this.$bus.$emit('new-file-open');
      return sourceTask;
    },
    createIcon(iconPath) {
      const { nativeImage } = this.$electron.remote;
      return nativeImage.createFromPath(path.join(__static, iconPath)).resize({
        width: 25,
      });
    },
  },
};
