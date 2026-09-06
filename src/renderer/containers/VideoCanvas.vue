<template>
  <div
    class="video"
  >
    <base-video-player
      v-if="!isImage"
      ref="videoCanvas"
      :key="originSrc"
      :needtimeupdate="true"
      :last-audio-track-id="lastAudioTrackId"
      :events="['loadedmetadata', 'audiotrack', 'playing', 'ended', 'timeupdate']"
      :styles="{objectFit: 'contain', width: '100%', height: '100%'}"
      :loop="loop"
      :crossOrigin="'anonymous'"
      :src="convertedSrc"
      :playback-rate="rate"
      :volume="volume"
      :muted="muted"
      :hwhevc="hwhevc"
      :paused="paused"
      :current-time="seekTime"
      :current-audio-track-id="currentAudioTrackId.toString()"
      :autoplay="false"
      @loadedmetadata="onMetaLoaded"
      @playing="switchingLock = false"
      @ended="handleVideoEnded"
      @error="handleMediaPlaybackError"
      @timeupdate="handleVideoTimeupdate"
      @audiotrack="onAudioTrack"
    />
    <img
      v-else
      ref="imageCanvas"
      :key="originSrc"
      :src="convertedSrc"
      :style="{objectFit: 'contain', width: '100%', height: '100%'}"
      alt=""
      class="image-element"
      @load="onImageLoaded"
      @error="handleImageError"
    />
    <div
      :style="{
        backgroundColor: maskBackground
      }"
      class="mask"
    />
    <canvas
      ref="thumbnailCanvas"
      class="canvas"
    />
  </div>
</template>;
<script lang="ts">
import { mapGetters, mapActions, mapMutations } from 'vuex';
import path from 'path';
import { debounce } from 'lodash';
import { windowRectService } from '@/services/window/WindowRectService';
import { playInfoStorageService } from '@/services/storage/PlayInfoStorageService';
import { settingStorageService } from '@/services/storage/SettingStorageService';
import { generateShortCutImageBy, ShortCut } from '@/libs/utils';
import { log } from '@/libs/Log';
import { zoomMediaFromPinch } from '@/helpers/mediaZoom';
import { Video as videoMutations } from '@/store/mutationTypes';
import { Video as videoActions } from '@/store/actionTypes';
import { videodata } from '@/store/video';
import BaseVideoPlayer from '@/components/PlayingView/BaseVideoPlayer.vue';
import { MediaItem } from '../interfaces/IDB';

const IMAGE_AUTOPLAY_DURATION = 3000;

export default {
  name: 'VideoCanvas',
  components: {
    'base-video-player': BaseVideoPlayer,
  },
  props: {
    brightness: {
      type: Number,
      default: 1,
    },
  },
  data() {
    return {
      videoExisted: false,
      videoElement: null,
      imageElement: null,
      seekTime: [0],
      lastAudioTrackId: 0,
      lastCoverDetectingTime: 0,
      maskBackground: 'rgba(255, 255, 255, 0)', // drag and drop related var
      asyncTasksDone: false, // window should not be closed until asyncTasks Done (only use
      closeTasksStarted: false,
      nowRate: 1,
      quit: false,
      needToRestore: false,
      winAngleBeforeFullScreen: 0, // winAngel before full screen
      winSizeBeforeFullScreen: [], // winSize before full screen
      switchingLock: false,
      folderAutoplayFallbackFired: false,
      imageAutoplayTimer: 0,
      imageAutoplayDeadline: 0,
      imageAutoplayRemaining: IMAGE_AUTOPLAY_DURATION,
      imageAutoplayPausedByUser: false,
      mediaZoom: 1,
      mediaPanX: 0,
      mediaPanY: 0,
      failedMediaSrc: '',
      mediaErrorAdvanced: false,
      audioCtx: null,
      gainNode: null,
      enableVideoInfoStore: false, // tag can save video data when quit
    };
  },
  computed: {
    ...mapGetters([
      'videoId', 'nextVideoId', 'originSrc', 'convertedSrc', 'volume', 'muted', 'rate', 'paused', 'casting', 'castPaused', 'duration', 'ratio', 'currentAudioTrackId', 'enabledSecondarySub', 'subToTop',
      'winSize', 'winPos', 'winAngle', 'isFullScreen', 'winWidth', 'winHeight', 'chosenStyle', 'chosenSize', 'nextVideo', 'loop', 'playinglistRate', 'isFolderList', 'playingList', 'playingIndex', 'playListId', 'items',
      'previousVideo', 'previousVideoId', 'incognitoMode', 'nsfwProcessDone', 'hwhevc', 'playlistLoop', 'isImage',
    ]),
    ...mapGetters({
      videoWidth: 'intrinsicWidth',
      videoHeight: 'intrinsicHeight',
      videoRatio: 'ratio',
    }),
  },
  watch: {
    brightness() {
      this.applyMediaAppearance();
    },
    loop(isLooping: boolean) {
      if (!this.isImage || !this.imageElement) return;
      if (isLooping) {
        this.clearImageAutoplayTimer();
      } else if (!this.imageAutoplayPausedByUser) {
        this.startImageAutoplay();
      }
    },
    playingList(newList: string[]) {
      this.advancePastFailedMediaIfPossible(newList);
      if (!this.isImage || !this.imageElement) return;
      if (newList.length <= 1) {
        this.clearImageAutoplayTimer();
        this.pause();
        videodata.paused = true;
      } else if (!this.imageAutoplayPausedByUser && !this.imageAutoplayTimer) {
        this.startImageAutoplay();
      }
    },
    winAngle(val: number) {
      this.changeWindowRotate(val);
    },
    async playListId(val: number, oldVal: number) {
      if (this.incognitoMode && Number.isFinite(oldVal)) {
        const playlistItem = await playInfoStorageService.getPlaylistRecord(oldVal);
        if (!playlistItem) return;
        const mediaItem = await playInfoStorageService
          .getMediaItem(playlistItem.items[playlistItem.playedIndex]);

        if (mediaItem && mediaItem.lastPlayedTime) return;

        await playInfoStorageService.deleteRecentPlayedBy(oldVal);
        return;
      }
      if (oldVal && !this.isFolderList) {
        await this.updatePlaylist(oldVal);
      }
    },
    async videoId(val: number, oldVal: number) {
      if (this.incognitoMode || !oldVal) return;
      const screenshot: ShortCut = await this.generateScreenshot();
      await this.saveScreenshot(oldVal, screenshot);
    },
    originSrc(val: string, oldVal: string) {
      this.clearImageAutoplayTimer();
      this.mediaZoom = 1;
      this.mediaPanX = 0;
      this.mediaPanY = 0;
      this.imageAutoplayPausedByUser = false;
      this.failedMediaSrc = '';
      this.mediaErrorAdvanced = false;
      this.enableVideoInfoStore = false;
      this.folderAutoplayFallbackFired = false;
      if (process.mas && oldVal) {
        this.$bus.$emit(`stop-accessing-${oldVal}`, oldVal);
      }
      if (this.isImage) {
        if (this.audioCtx) {
          this.audioCtx.close();
          this.audioCtx = null;
        }
        this.videoElement = null;
        this.imageElement = null;
      } else if (!this.audioCtx) {
        this.audioCtx = new AudioContext();
      }
      // this.$bus.$emit('show-speedlabel');
      this.videoConfigInitialize({
        audioTrackList: [],
      });
      if (this.isImage) {
        this.videoConfigInitialize({
          paused: true,
          duration: NaN,
          currentTime: 0,
        });
        videodata.paused = true;
      } else {
        this.play();
      }
      this.updatePlayinglistRate({
        oldDir: path.dirname(oldVal), newDir: path.dirname(val), playingList: this.playingList,
      });
      this.playinglistRate.forEach((item: {
        dirPath: string,
        rate: number,
        playingList: string[],
      }) => {
        if (item.dirPath === path.dirname(val)) {
          this.$store.dispatch(videoActions.CHANGE_RATE, item.rate);
          this.nowRate = item.rate;
        }
      });
    },
    volume(val: number) {
      if (val > 1) this.amplifyAudio(val);
      else this.amplifyAudio(1);
    },
  },
  created() {
    this.updatePlayinglistRate({ oldDir: '', newDir: path.dirname(this.originSrc), playingList: this.playingList });
  },
  mounted() {
    this.audioCtx = this.isImage ? null : new AudioContext();
    this.$bus.$on('back-to-landingview', () => {
      this.backToLandingView();
      return false;
    });
    this.$electron.ipcRenderer.on('quit', (e: Event, needToRestore: boolean) => {
      if (needToRestore) this.needToRestore = needToRestore;
      this.quit = true;
    });
    this.videoElement = this.isImage ? null : this.$refs.videoCanvas.videoElement();
    this.imageElement = this.isImage ? this.$refs.imageCanvas : null;
    this.$bus.$on('toggle-fullscreen', () => {
      if (!this.isFullScreen) {
        this.toFullScreen();
      } else {
        this.offFullScreen();
      }
      this.$electron.ipcRenderer.send('callMainWindowMethod', 'setFullScreen', [!this.isFullScreen]);
      this.$ga.event('app', 'toggle-fullscreen');
    });
    this.$bus.$on('to-fullscreen', () => {
      this.toFullScreen();
    });
    this.$bus.$on('off-fullscreen', () => {
      this.offFullScreen();
    });
    this.$bus.$on('toggle-muted', () => {
      this.toggleMute();
    });
    this.$bus.$on('toggle-playback', debounce(() => {
      if (this.isImage) {
        if (this.paused) this.resumeImageAutoplay();
        else this.pauseImageAutoplay();
        return;
      }
      if (this.casting) {
        this.$electron.ipcRenderer.send(this.castPaused ? 'cast-play' : 'cast-pause');
        this.updateCastPaused(!this.castPaused);
        return;
      }
      this[this.paused ? 'play' : 'pause']();
      // this.$ga.event('app', 'toggle-playback');
    }, 50, { leading: true }));
    this.$bus.$on('next-video', async () => {
      if (this.switchingLock) return;
      if (this.isFolderList) {
        await this.openNextFolderVideo();
        return;
      }
      if (this.nextVideo === undefined) { // 非列表循环或单曲循环时，当前播放列表已经播完
        this.$router.push({ name: 'landing-view' });
        return;
      }
      this.switchingLock = true;
      videodata.paused = false;
      if (this.nextVideo !== '') {
        if (this.isFolderList) this.openVideoFile(this.nextVideo, { keepCurrentFolderList: true });
        else this.playFile(this.nextVideo, this.nextVideoId);
      } else if (this.nextVideo === '') { // 单曲循环时，nextVideo返回空字符串
        this.$store.commit('LOOP_UPDATE', true);
        this.$bus.$emit('seek', Math.ceil(this.duration));
      }
    });
    this.$bus.$on('previous-video', this.playPreviousVideo);
    this.$bus.$on('seek', (e: number) => {
      if (this.casting) this.$electron.ipcRenderer.send('cast-seek', e);
      // update vuex currentTime to use some where
      this.seekTime = [e];
      this.updateVideoCurrentTime(e);
    });
    this.$bus.$on('seek-forward', (delta: number) => this.$bus.$emit('seek', videodata.time + Math.abs(delta)));
    this.$bus.$on('seek-backward', (delta: number) => {
      const finalSeekTime = videodata.time - Math.abs(delta);
      // find a way to stop wheel event until next begin
      // if (finalSeekTime <= 0)
      this.$bus.$emit('seek', finalSeekTime);
    });
    this.$bus.$on('drag-over', () => {
      this.maskBackground = 'rgba(255, 255, 255, 0.18)';
    });
    this.$bus.$on('drag-leave', () => {
      this.maskBackground = 'rgba(255, 255, 255, 0)';
    });
    this.$bus.$on('drop', () => {
      this.maskBackground = 'rgba(255, 255, 255, 0)';
      this.$ga.event('app', 'drop');
    });
    this.$bus.$on('mask-highlight', (on: boolean) => { this.maskBackground = `rgba(255, 255, 255, ${on ? 0.18 : 0})`; });
    window.addEventListener('beforeunload', this.beforeUnloadHandler);
  },
  beforeUnmount() {
    this.clearImageAutoplayTimer();
    if (this.casting) this.$electron.ipcRenderer.send('cast-stop');
    if (this.audioCtx) this.audioCtx.close();
    if (process.mas) this.$bus.$emit(`stop-accessing-${this.originSrc}`, this.originSrc);
    window.removeEventListener('beforeunload', this.beforeUnloadHandler);
  },
  methods: {
    ...mapMutations({
      updateVideoCurrentTime: videoMutations.CURRENT_TIME_UPDATE,
      updateCastPaused: videoMutations.CAST_PAUSED_UPDATE,
    }),
    ...mapActions({
      videoConfigInitialize: videoActions.INITIALIZE,
      play: videoActions.PLAY_VIDEO,
      pause: videoActions.PAUSE_VIDEO,
      updateMetaInfo: videoActions.META_INFO,
      toggleMute: videoActions.TOGGLE_MUTED,
      addAudioTrack: videoActions.ADD_AUDIO_TRACK,
      switchAudioTrack: videoActions.SWITCH_AUDIO_TRACK,
      removeAllAudioTrack: videoActions.REMOVE_ALL_AUDIO_TRACK,
      updatePlayinglistRate: videoActions.UPDATE_PLAYINGLIST_RATE,
    }),
    async playPreviousVideo() {
      if (this.switchingLock) return;
      if (this.isFolderList) {
        await this.openPreviousFolderVideo();
        return;
      }
      if (this.previousVideo === undefined) { // 同上，当前为播放列表第一个视频
        this.$bus.$emit('seek', 0);
        return;
      }
      this.switchingLock = true;
      videodata.paused = false;
      if (this.previousVideo !== '') {
        this.playFile(this.previousVideo, this.previousVideoId);
      } else if (this.previousVideo === '') {
        this.$store.commit('LOOP_UPDATE', true);
        this.$bus.$emit('seek', 0);
      }
    },
    onImageLoaded(event: Event) {
      const target = event.target as HTMLImageElement;
      if (!target.naturalWidth || !target.naturalHeight) return;
      this.imageElement = target;
      this.switchingLock = false;
      this.imageAutoplayPausedByUser = false;
      this.videoExisted = true;
      this.seekTime = [0];
      const shouldAutoplay = this.canAutoplayImage();
      this.videoConfigInitialize({
        paused: !shouldAutoplay,
        duration: NaN,
        currentTime: 0,
      });
      videodata.paused = !shouldAutoplay;
      this.updateVideoCurrentTime(0);
      this.updateMetaInfo({
        intrinsicWidth: target.naturalWidth,
        intrinsicHeight: target.naturalHeight,
        ratio: target.naturalWidth / target.naturalHeight,
      });
      this.changeWindowRotate(this.winAngle);
      this.applyMediaAppearance();
      this.windowRectControl();
      this.$emit('media-ready', this.originSrc);
      this.enableVideoInfoStore = true;
      if (shouldAutoplay) this.scheduleImageAutoplay();
    },
    canAutoplayImage() {
      return this.isImage && !this.loop
        && Array.isArray(this.playingList) && this.playingList.length > 1;
    },
    clearImageAutoplayTimer(preserveRemaining = false) {
      if (this.imageAutoplayTimer) {
        if (preserveRemaining && this.imageAutoplayDeadline) {
          this.imageAutoplayRemaining = Math.max(
            0, this.imageAutoplayDeadline - Date.now(),
          );
        }
        clearTimeout(this.imageAutoplayTimer);
        this.imageAutoplayTimer = 0;
      }
      this.imageAutoplayDeadline = 0;
      if (!preserveRemaining) this.imageAutoplayRemaining = IMAGE_AUTOPLAY_DURATION;
    },
    startImageAutoplay() {
      if (!this.canAutoplayImage() || this.imageAutoplayPausedByUser) return;
      this.play();
      videodata.paused = false;
      this.scheduleImageAutoplay();
    },
    pauseImageAutoplay() {
      this.imageAutoplayPausedByUser = true;
      this.clearImageAutoplayTimer(true);
      this.pause();
      videodata.paused = true;
    },
    resumeImageAutoplay() {
      if (!this.canAutoplayImage()) return;
      this.imageAutoplayPausedByUser = false;
      this.startImageAutoplay();
    },
    scheduleImageAutoplay() {
      if (!this.canAutoplayImage() || this.imageAutoplayPausedByUser) return;

      const delay = Math.max(1, this.imageAutoplayRemaining || IMAGE_AUTOPLAY_DURATION);
      this.clearImageAutoplayTimer();
      this.imageAutoplayRemaining = delay;
      const source = this.originSrc;
      this.imageAutoplayDeadline = Date.now() + delay;
      this.imageAutoplayTimer = setTimeout(() => {
        this.imageAutoplayTimer = 0;
        this.imageAutoplayDeadline = 0;
        this.imageAutoplayRemaining = IMAGE_AUTOPLAY_DURATION;
        if (this.isImage && this.originSrc === source && !this.switchingLock) {
          this.$bus.$emit('next-video');
        }
      }, delay);
    },
    async onMetaLoaded(event: Event) { // eslint-disable-line complexity
      const target = event.target as HTMLVideoElement;
      this.videoElement = target;
      if (!this.audioCtx) this.audioCtx = new AudioContext();

      const mediaInfo = this.videoId
        ? await playInfoStorageService.getMediaItem(this.videoId)
        : null;
      if (!this.$refs.videoCanvas || this.$refs.videoCanvas.videoElement() !== target) return;
      let currentTime = 0;
      if (mediaInfo && mediaInfo.lastPlayedTime
        && target.duration - mediaInfo.lastPlayedTime > 10) {
        currentTime = mediaInfo.lastPlayedTime;
      }
      this.videoElement.currentTime = currentTime;
      this.$bus.$emit('seek', currentTime);

      this.videoConfigInitialize({
        volume: this.volume * 100,
        muted: this.muted,
        rate: this.nowRate,
        duration: target.duration,
        currentTime,
      });

      const isMountedMedia = process.platform === 'darwin'
        ? this.originSrc.indexOf('/Volumes/') === 0
        : /^\\\\/.test(this.originSrc);
      // A contact sheet scans the entire movie. On a network mount that can
      // monopolize SMB bandwidth and starve playback, so generate it on local media only.
      if (target.duration && Number.isFinite(target.duration) && !isMountedMedia) {
        this.$bus.$emit('generate-thumbnails');
      }

      this.updateMetaInfo({
        intrinsicWidth: target.videoWidth,
        intrinsicHeight: target.videoHeight,
        ratio: target.videoWidth / target.videoHeight,
      });
      this.changeWindowRotate(this.winAngle);
      this.applyMediaAppearance();
      // Keep the user-selected window dimensions when the media source changes.

      if (mediaInfo && mediaInfo.audioTrackId) this.lastAudioTrackId = mediaInfo.audioTrackId;
      this.gainNode = this.audioCtx.createGain();
      this.audioCtx.createMediaElementSource(target).connect(this.gainNode);
      this.gainNode.connect(this.audioCtx.destination);
      if (this.volume > 1) this.amplifyAudio(this.volume);

      if (!this.paused) this.videoElement.play();
      this.$emit('media-ready', this.originSrc);
      setTimeout(() => {
        if (this.videoElement === target) this.enableVideoInfoStore = true;
      }, 20);
    },
    async openNextFolderVideo() {
      this.folderAutoplayFallbackFired = true;
      const list = await this.getCurrentFolderVideos();
      const index = list.findIndex((item: string) => item === this.originSrc);
      const nextVideo = index >= 0 ? list[index + 1] : list[0];
      if (!nextVideo) {
        if (this.playlistLoop && list.length > 1) {
          await this.openFolderVideo(list[0], list);
        } else {
          this.$router.push({ name: 'landing-view' });
        }
        return;
      }
      await this.openFolderVideo(nextVideo, list);
    },
    async openPreviousFolderVideo() {
      const list = await this.getCurrentFolderVideos();
      const index = list.findIndex((item: string) => item === this.originSrc);
      const previousVideo = index > 0 ? list[index - 1] : undefined;
      if (!previousVideo) {
        if (this.playlistLoop && list.length > 1) {
          await this.openFolderVideo(list[list.length - 1], list);
        } else {
          this.$bus.$emit('seek', 0);
        }
        return;
      }
      await this.openFolderVideo(previousVideo, list);
    },
    handleVideoTimeupdate(event: Event) {
      if (this.loop || !this.isFolderList
        || this.switchingLock || this.folderAutoplayFallbackFired) return;
      const video = event.target as HTMLVideoElement;
      if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
      if (video.currentTime < video.duration - 0.25) return;
      this.$bus.$emit('next-video');
    },
    handleVideoEnded() {
      if (!this.loop) this.$bus.$emit('next-video');
    },
    async getCurrentFolderVideos() {
      let list = Array.isArray(this.playingList) ? this.playingList.filter(Boolean) : [];
      if (list.length <= 1 || !list.includes(this.originSrc)) {
        list = await this.findSimilarVideoByVidPath(this.originSrc);
        if (list.length > 0) {
          this.$store.dispatch('FolderList', {
            id: this.playListId,
            paths: list,
          });
        }
      }
      return list;
    },
    async openFolderVideo(video: string, list: string[]) {
      this.switchingLock = true;
      videodata.paused = false;
      if (list.length > 0) {
        this.$store.dispatch('FolderList', {
          id: this.playListId,
          paths: list,
          items: this.items,
        });
      }
      await this.openVideoFile(video, { keepCurrentFolderList: true });
    },
    amplifyAudio(gain: number) {
      if (this.gainNode && this.gainNode.gain) this.gainNode.gain.value = gain;
    },
    handleMediaPinch(event: WheelEvent) {
      const zoom = zoomMediaFromPinch(this.mediaZoom, event);
      if (zoom === this.mediaZoom) return;
      this.mediaZoom = zoom;
      if (zoom === 1) {
        this.mediaPanX = 0;
        this.mediaPanY = 0;
      }
      this.changeWindowRotate(this.winAngle);
    },
    canPanMedia() {
      return this.mediaZoom > 1 && !!this.mediaContainerElement();
    },
    mediaPanPosition() {
      return { x: this.mediaPanX, y: this.mediaPanY };
    },
    setMediaPan(x: number, y: number) {
      if (!this.canPanMedia()) return;
      this.mediaPanX = x;
      this.mediaPanY = y;
      this.applyMediaTransform(this.isFullScreen, this.winAngle);
    },
    mediaPanBounds(mediaContainer = this.mediaContainerElement()) {
      const viewport = this.$el as HTMLElement;
      if (!viewport || !mediaContainer) return { x: 0, y: 0 };
      const viewportRect = viewport.getBoundingClientRect();
      const mediaRect = mediaContainer.getBoundingClientRect();
      return {
        x: Math.max(0, (mediaRect.width - viewportRect.width) / 2),
        y: Math.max(0, (mediaRect.height - viewportRect.height) / 2),
      };
    },
    clampMediaPan(x = this.mediaPanX, y = this.mediaPanY) {
      const bounds = this.mediaPanBounds();
      const clamp = (value: number, limit: number) => Math.min(limit, Math.max(-limit, value));
      return {
        x: clamp(x, bounds.x),
        y: clamp(y, bounds.y),
      };
    },
    onAudioTrack(event: TrackEvent) {
      const { type, track } = event;
      this[`${type}AudioTrack`](track);
    },
    windowRectControl() {
      let videoSize;
      const [winWidth, winHeight] = this.winSize;
      const oldRatio = winWidth / winHeight;
      const isLandscape = (ratio: number) => ratio > 1;
      if (
        this.videoExisted
        && (isLandscape(this.ratio) === isLandscape(oldRatio)) // 同为landscpae或portrait
      ) {
        if (this.ratio > 1) {
          videoSize = [winHeight * this.ratio, winHeight];
        } else {
          videoSize = [winWidth, winWidth / this.ratio];
        }
      } else {
        videoSize = [this.videoWidth, this.videoHeight];
        const availWidth = window.screen.availWidth;
        const availHeight = window.screen.availHeight;
        if (this.ratio > 1 && videoSize[0] > availWidth * 0.7) {
          videoSize[0] = availWidth * 0.7;
          videoSize[1] = videoSize[0] / this.ratio;
        } else if (this.ratio <= 1 && videoSize[1] > availHeight * 0.7) {
          videoSize[1] = availHeight * 0.7;
          videoSize[0] = videoSize[1] * this.ratio;
        }
        this.videoExisted = true;
      }
      if (this.winAngle !== 0 && this.winAngle !== 180) videoSize.reverse();
      const oldRect = this.winPos.concat(this.winSize);
      windowRectService.calculateWindowRect(videoSize, true, oldRect);
    },
    changeWindowRotate(val: number) {
      requestAnimationFrame(() => {
        this.applyMediaTransform(this.isFullScreen, val);
      });
    },
    toFullScreen() {
      this.winSizeBeforeFullScreen = this.winSize;
      this.winAngleBeforeFullScreen = this.winAngle;
      requestAnimationFrame(() => {
        this.applyMediaTransform(true, this.winAngle);
      });
      windowRectService.uploadWindowBy(true);
    },
    offFullScreen() {
      requestAnimationFrame(() => {
        this.applyMediaTransform(false, this.winAngle);
      });
      windowRectService.uploadWindowBy(false, 'playing-view', this.winAngle, this.winAngleBeforeFullScreen, this.winSizeBeforeFullScreen, this.winPos);
    },
    applyMediaTransform(fullScreen: boolean, angle: number) {
      const mediaContainer = this.mediaContainerElement();
      if (!mediaContainer) return;
      const scale = windowRectService.calculateWindowScaleBy(fullScreen, angle, this.ratio)
        * this.mediaZoom;
      const updateTransform = () => {
        mediaContainer.style.setProperty(
          'transform',
          `translate(${this.mediaPanX}px, ${this.mediaPanY}px) rotate(${angle}deg) scale(${scale}, ${scale})`,
        );
      };
      updateTransform();
      const pan = this.clampMediaPan();
      if (pan.x !== this.mediaPanX || pan.y !== this.mediaPanY) {
        this.mediaPanX = pan.x;
        this.mediaPanY = pan.y;
        updateTransform();
      }
    },
    applyMediaAppearance() {
      const mediaContainer = this.mediaContainerElement();
      if (!mediaContainer) return;
      const brightness = Number(this.brightness);
      if (!Number.isFinite(brightness) || brightness === 1) {
        mediaContainer.style.removeProperty('filter');
        return;
      }
      mediaContainer.style.setProperty('filter', `brightness(${Math.min(2, Math.max(0.5, brightness))})`);
    },
    mediaContainerElement() {
      const media = this.isImage ? this.$refs.imageCanvas : this.$refs.videoCanvas;
      return media && (media.$el || media);
    },
    async updatePlaylist(playlistId: number) {
      if (Number.isFinite(playlistId) && !this.isFolderList) {
        const playlistRecord = await playInfoStorageService.getPlaylistRecord(playlistId);
        if (!playlistRecord) return;
        playlistRecord.playedIndex = this.playingIndex;

        await playInfoStorageService
          .updateRecentPlayedBy(playlistId, playlistRecord);
      }
    },
    async generateScreenshot(): Promise<ShortCut> {
      const mediaElement = this.isImage ? this.imageElement : this.videoElement;
      const canvas = this.$refs.thumbnailCanvas;
      // todo: use metaloaded to get videoHeight and videoWidth
      const { videoHeight, videoWidth } = this;
      const shortCut = mediaElement
        ? generateShortCutImageBy(mediaElement, canvas, videoWidth, videoHeight)
        : { shortCut: '', smallShortCut: '' };
      return shortCut;
    },
    async saveScreenshot(videoId: number, screenshot: ShortCut) {
      const data = {
        shortCut: screenshot.shortCut,
        smallShortCut: screenshot.smallShortCut,
        lastPlayedTime: videodata.time,
        duration: this.duration,
        audioTrackId: this.currentAudioTrackId,
      };

      const result = await playInfoStorageService.updateMediaItemBy(videoId, data as MediaItem);
      // @ts-ignore
      if (result) this.$bus.$emit('database-saved', result);
    },
    saveSubtitleStyle() {
      return settingStorageService.updateSubtitleStyle({
        chosenStyle: this.chosenStyle,
        chosenSize: this.chosenSize,
        enabledSecondarySub: this.enabledSecondarySub,
      });
    },
    savePlaybackStates() {
      return settingStorageService.updatePlaybackStates({ volume: this.volume, muted: this.muted });
    },
    async handleLeaveVideo(videoId: number) {
      const playListId = this.playListId;
      // incognito mode
      if (this.incognitoMode) {
        if (!Number.isFinite(playListId)) return;
        const playlistItem = await playInfoStorageService.getPlaylistRecord(playListId);
        if (!playlistItem) return;
        const mediaItem = await playInfoStorageService
          .getMediaItem(playlistItem.items[playlistItem.playedIndex]);

        if (mediaItem && mediaItem.lastPlayedTime) return;

        await playInfoStorageService.deleteRecentPlayedBy(playListId);
        return;
      }
      let savePromise = new Promise((resolve) => {
        resolve();
      });
      if (this.enableVideoInfoStore) {
        const screenshot: ShortCut = await this.generateScreenshot();
        savePromise = this.saveScreenshot(videoId, screenshot)
          .then(() => this.updatePlaylist(playListId));
      }
      if (process.mas && this.$store.getters.source === 'drop') {
        savePromise = savePromise.then(async () => {
          await playInfoStorageService.deleteRecentPlayedBy(playListId);
        });
      }
      await (savePromise
        .then(this.saveSubtitleStyle)
        .then(this.savePlaybackStates));
    },
    beforeUnloadHandler(e: BeforeUnloadEvent) {
      if (!this.asyncTasksDone && !this.needToRestore) {
        e.returnValue = false;
        if (this.closeTasksStarted) return;
        this.closeTasksStarted = true;
        // Keep the asynchronous save out of view without hiding sibling player
        // windows. app.hide() hides every window in the application on macOS.
        this.$electron.remote.getCurrentWindow().hide();
        this.$electron.remote.getCurrentWebContents().audioMuted = true;
        this.handleLeaveVideo(this.videoId)
          .finally(() => {
            this.removeAllAudioTrack();
            this.$store.dispatch('SRC_SET', { src: '', mediaHash: '', id: NaN });
            this.asyncTasksDone = true;
            window.close();
          });
      } else if (this.quit) {
        this.$electron.remote.app.quit();
      }
    },
    handleImageError() {
      log.warn('image element onerror', this.originSrc);
      this.handleMediaPlaybackError();
    },
    handleMediaPlaybackError() {
      if (this.failedMediaSrc !== this.originSrc) {
        this.failedMediaSrc = this.originSrc;
        this.mediaErrorAdvanced = false;
      }
      this.advancePastFailedMediaIfPossible();
    },
    advancePastFailedMediaIfPossible(list = this.playingList) {
      if (!this.failedMediaSrc || this.failedMediaSrc !== this.originSrc
        || this.mediaErrorAdvanced || !Array.isArray(list) || list.length <= 1) return;
      this.mediaErrorAdvanced = true;
      this.switchingLock = false;
      this.$bus.$emit('next-video');
    },
    backToLandingView() {
      this.handleLeaveVideo(this.videoId)
        .finally(() => {
          this.removeAllAudioTrack();
          this.$bus.$emit('videocanvas-saved');
        });
    },
  },
};
</script>
<style lang="scss" scoped>
.video {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  z-index: auto;
}
.mask {
  position: absolute;
  inset: 0;
  pointer-events: none;
  transition: background-color 120ms linear;
}
.base-video-player {
  width: 100%;
  height: 100%;
  position: absolute;
  inset: 0;
}
.image-element {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.base-video-player,
.image-element {
  will-change: transform, filter;
}
.canvas {
  visibility: hidden;
}
</style>
