<template>
  <div
    class="player trackpad-surface"
    @wheel.capture="handleMediaPinch"
    @pointerdown.capture="startMediaPan"
    @pointermove.capture="moveMediaPan"
    @pointerup.capture="endMediaPan"
    @pointercancel.capture="endMediaPan"
    @mousedown.capture="suppressMediaMouseDown"
    @click.capture="handleMediaClick"
  >
    <the-video-canvas
      ref="videoCanvas"
      :brightness="brightness"
      @media-ready="onMediaReady"
    />
    <subtitle-image-renderer
      :windowWidth="winWidth"
      :windowHeight="winHeight"
      :currentCues="allCues"
    />
    <the-video-controller
      ref="videoctrl"
      :brightness="brightness"
      @update:brightness="updateBrightness"
    />
    <thumbnailPost
      :key="savedName"
      v-if="generatePost"
      :generate-type="generateType"
      :saved-name="savedName"
      @generated="generatePost = false"
    />
  </div>
</template>

<script lang="ts">
import type { NavigationGuardNext, RouteLocationNormalized } from 'vue-router';
import { mapActions, mapGetters, mapMutations } from 'vuex';
import { basename } from 'path';
import { Subtitle as subtitleActions, SubtitleManager as smActions } from '@/store/actionTypes';
import SubtitleImageRenderer from '@/components/SubtitleImageRenderer.vue';
import thumbnailPost from '@/components/PlayingView/ThumbnailPost/ThumbnailPost.vue';
import VideoCanvas from '@/containers/VideoCanvas.vue';
import TheVideoController from '@/containers/TheVideoController.vue';
import { isMediaPinchGesture } from '@/helpers/mediaZoom';
import { videodata } from '../store/video';
import { getStreams } from '../plugins/mediaTasks';

export default {
  name: 'PlayingView',
  components: {
    'the-video-controller': TheVideoController,
    'the-video-canvas': VideoCanvas,
    'subtitle-image-renderer': SubtitleImageRenderer,
    thumbnailPost,
  },
  data() {
    return {
      currentCues: [
        {
          cues: [],
          subPlayResX: 720,
          subPlayResY: 405,
        },
        {
          cues: [],
          subPlayResX: 720,
          subPlayResY: 405,
        },
      ],
      generatePost: false,
      generateType: NaN,
      showingPopupDialog: false,
      savedName: '',
      mediaReadySrc: '',
      initializedMediaKey: '',
      brightness: 1,
      mediaPanPointerId: null as number | null,
      mediaPanStart: { x: 0, y: 0 },
      mediaPanOrigin: { x: 0, y: 0 },
      isMediaPanning: false,
      skipNextMediaClick: false,
    };
  },
  computed: {
    ...mapGetters(['originSrc', 'mediaHash', 'duration', 'winWidth', 'winHeight', 'isProfessional', 'primarySubtitleId', 'secondarySubtitleId', 'isFolderList', 'isImage']),
    allCues() {
      return Array.isArray(this.currentCues)
        ? this.currentCues.flatMap(({ cues }: { cues: [] }) => cues)
        : [];
    },
  },
  watch: {
    originSrc: {
      immediate: true,
      // eslint-disable-next-line
      handler: function (newVal: string) {
        this.generatePost = false;
        this.mediaReadySrc = '';
        this.initializedMediaKey = '';
        this.mediaPanPointerId = null;
        this.isMediaPanning = false;
        this.skipNextMediaClick = false;
        this.resetManager();
      },
    },
    mediaHash() {
      this.initializeMediaFeatures(this.originSrc);
    },
    async primarySubtitleId() {
      this.currentCues = await this.getCues(videodata.time);
    },
    async secondarySubtitleId() {
      this.currentCues = await this.getCues(videodata.time);
    },
  },
  mounted() {
    this.$store.dispatch('initWindowRotate');
    this.$electron.ipcRenderer.send('callMainWindowMethod', 'setMinimumSize', [320, 180]);
    // 这里设置了最小宽高，需要同步到vuex
    this.windowMinimumSize([320, 180]);
    videodata.checkTick();
    videodata.onTick = this.onUpdateTick;
    requestAnimationFrame(this.loopCues);
    this.$bus.$on('add-subtitles', (subs: { src: string, type: string }[]) => {
      const paths = subs.map((sub: { src: string, type: string }) => (sub.src));
      this.addLocalSubtitlesWithSelect(paths);
    });
    this.$bus.$on('generate-post', this.generatePostHandler);
  },
  beforeRouteLeave(
    to: RouteLocationNormalized,
    from: RouteLocationNormalized,
    next: NavigationGuardNext,
  ) {
    this.$bus.$once('videocanvas-saved', () => {
      this.$store.dispatch('Init');
      // Each component's bus listeners are removed when it unmounts.
      next();
    });
    if (to.name !== 'browsing-view') this.$store.dispatch('UPDATE_SHOW_SIDEBAR', false);
    this.$bus.$emit('back-to-landingview');
  },
  beforeUnmount() {
    this.updateSubToTop(false);
    videodata.stopCheckTick();
  },
  methods: {
    ...mapMutations({
      windowMinimumSize: 'windowMinimumSize',
    }),
    ...mapActions({
      updateSubToTop: subtitleActions.UPDATE_SUBTITLE_TOP,
      resetManager: smActions.resetManager,
      initializeManager: smActions.initializeManager,
      addLocalSubtitlesWithSelect: smActions.addLocalSubtitlesWithSelect,
      getCues: smActions.getCues,
      updatePlayTime: smActions.updatePlayedTime,
    }),
    onMediaReady(src: string) {
      if (!src || src !== this.originSrc) return;
      this.mediaReadySrc = src;
      this.initializeMediaFeatures(src);
    },
    initializeMediaFeatures(src: string) {
      if (!src || src !== this.originSrc || this.mediaReadySrc !== src || !this.mediaHash) return;
      const key = `${src}\u0000${this.mediaHash}`;
      if (key === this.initializedMediaKey) return;
      this.initializedMediaKey = key;
      if (this.isImage) {
        if (this.isFolderList) this.$store.dispatch('UpdatePlayingList');
        return;
      }
      getStreams(src);
      this.initializeManager();
      if (this.isFolderList) this.$store.dispatch('UpdatePlayingList');
    },
    // Compute UI states
    // When the video is playing the ontick is triggered by ontimeupdate of Video tag,
    // else it is triggered by setInterval.
    onUpdateTick() {
      requestAnimationFrame(this.loopCues);
      this.$refs.videoctrl.onTickUpdate();
    },
    generatePostHandler(type: number) {
      this.generatePost = true;
      this.generateType = type;
      this.savedName = this.generateThumbnailFilename(type);
    },
    generateThumbnailFilename(type: number) {
      const date = new Date();
      return `SPlayer-${date.getFullYear()}${date.getMonth()}${date.getDate()}`
          + `-${basename(this.originSrc)}-${type}x${type}`;
    },
    updateBrightness(value: number) {
      const brightness = Number(value);
      this.brightness = Number.isFinite(brightness)
        ? Math.min(2, Math.max(0.5, brightness)) : 1;
    },
    handleMediaPinch(event: WheelEvent) {
      if (!isMediaPinchGesture(event)) return;
      event.preventDefault();
      event.stopPropagation();
      this.$refs.videoCanvas.handleMediaPinch(event);
    },
    isMediaPanTarget(target: EventTarget | null) {
      if (!(target instanceof Element)) return false;
      return !target.closest(
        '.no-drag, button, input, select, textarea, .mainMenu, .subtitle-editor, '
        + '.play-button, .the-progress-bar, .recent-playlist, .notification-bubble, '
        + '.cast-top, .control-buttons, .sub-control-wrapper',
      );
    },
    startMediaPan(event: PointerEvent) {
      if (this.isProfessional || event.button !== 0 || !this.isMediaPanTarget(event.target)) return;
      const mediaCanvas = this.$refs.videoCanvas;
      if (!mediaCanvas || !mediaCanvas.canPanMedia()) return;

      event.preventDefault();
      event.stopPropagation();
      this.mediaPanPointerId = event.pointerId;
      this.mediaPanStart = { x: event.clientX, y: event.clientY };
      this.mediaPanOrigin = mediaCanvas.mediaPanPosition();
      this.isMediaPanning = false;
      const player = event.currentTarget as HTMLElement;
      if (player.setPointerCapture) player.setPointerCapture(event.pointerId);
    },
    moveMediaPan(event: PointerEvent) {
      if (event.pointerId !== this.mediaPanPointerId) return;
      const deltaX = event.clientX - this.mediaPanStart.x;
      const deltaY = event.clientY - this.mediaPanStart.y;
      if (!this.isMediaPanning && Math.hypot(deltaX, deltaY) < 2) return;

      this.isMediaPanning = true;
      this.skipNextMediaClick = true;
      event.preventDefault();
      event.stopPropagation();
      this.$refs.videoCanvas.setMediaPan(
        this.mediaPanOrigin.x + deltaX,
        this.mediaPanOrigin.y + deltaY,
      );
    },
    endMediaPan(event: PointerEvent) {
      if (event.pointerId !== this.mediaPanPointerId) return;
      const wasPanning = this.isMediaPanning;
      const player = event.currentTarget as HTMLElement;
      if (player.hasPointerCapture && player.hasPointerCapture(event.pointerId)) {
        player.releasePointerCapture(event.pointerId);
      }
      this.mediaPanPointerId = null;
      this.isMediaPanning = false;
      if (!wasPanning) return;

      event.preventDefault();
      event.stopPropagation();
    },
    suppressMediaMouseDown(event: MouseEvent) {
      if (this.mediaPanPointerId === null) return;
      event.preventDefault();
      event.stopPropagation();
    },
    handleMediaClick(event: MouseEvent) {
      if (!this.skipNextMediaClick) return;
      this.skipNextMediaClick = false;
      event.preventDefault();
      event.stopPropagation();
    },
    async loopCues() {
      if (this.isImage) return;
      if (!this.time) this.time = videodata.time;
      // onUpdateTick Always get the latest subtitles
      // if (this.time !== videodata.time) {
      const cues = await this.getCues(videodata.time);
      this.updatePlayTime({ start: this.time, end: videodata.time });
      this.currentCues = cues;
      // }
      this.time = videodata.time;
    },
  },
};
</script>

<style lang="scss">
.player {
  transition-property: width;
  transition-duration: 100ms;
  transition-timing-function: ease-out;

  position: absolute;
  right: 0;

  height: 100%;
  background-color: black;
}
</style>
