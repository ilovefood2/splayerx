import { ipcRenderer } from 'electron';
import type { CastDeviceInfo } from '../../main/helpers/cast/CastDiscovery';
import type { CastStatus } from '../../main/helpers/cast/CastService';
import { Video as videoActions } from '@/store/actionTypes';
import { Video as videoMutations } from '@/store/mutationTypes';
import { videodata } from '@/store/video';
import { addBubble } from '@/helpers/notificationControl';
import {
  CAST_NO_DEVICE, CAST_NOT_LOCAL, CAST_UNSUPPORTED, CAST_FAILED,
} from '@/helpers/notificationcodes';

export const castPlayback = {
  data() {
    return {
      castTarget: null as CastDeviceInfo | null,
      castSource: '',
      castRequest: 0,
      castPreparing: false,
      castAdvanceRequested: false,
      castPendingStatus: null as CastStatus | null,
    };
  },
  watch: {
    originSrc(source: string) {
      if (!this.castTarget) return;
      if (source) this.loadCastSource(0);
      else this.stopCasting();
    },
    $route(route: { name: string }) {
      if (route.name !== 'playing-view' && this.castTarget) this.stopCasting();
    },
  },
  methods: {
    stopCasting(resume = false) {
      const hadSession = this.castTarget || this.casting;
      const requestId = this.castRequest;
      const source = this.castSource;
      const position = videodata.time;
      this.castRequest += 1;
      this.castTarget = null;
      this.castSource = '';
      this.castPreparing = false;
      this.castAdvanceRequested = false;
      this.castPendingStatus = null;
      this.$store.commit(videoMutations.CASTING_UPDATE, false);
      this.$store.commit(videoMutations.CAST_PAUSED_UPDATE, true);
      if (hadSession) ipcRenderer.send('cast-stop', { requestId });
      if (source && source === this.originSrc && !this.$store.getters.isImage
        && Number.isFinite(position)) this.$bus.$emit('seek', position);
      this.$store.dispatch(resume ? videoActions.PLAY_VIDEO : videoActions.PAUSE_VIDEO);
      this.$bus.$emit('cast-media-stopped', { resume });
    },
    async castToDevice() {
      if (this.castTarget || this.casting) {
        this.stopCasting();
        return;
      }
      if (!this.originSrc || /^https?:/.test(this.originSrc)) {
        addBubble(CAST_NOT_LOCAL);
        return;
      }
      const pickingSource = this.originSrc;
      const devices = await ipcRenderer.invoke('cast-list-devices');
      if (!devices || !devices.length) {
        addBubble(CAST_NO_DEVICE);
        return;
      }
      const cancelId = devices.length;
      const { response } = await this.$electron.remote.dialog.showMessageBox({
        type: 'question',
        message: this.$t('msg.playback.castTo'),
        buttons: devices.map((device: CastDeviceInfo) => device.name)
          .concat([this.$t('msg.playback.castCancel')]),
        cancelId,
        defaultId: 0,
      });
      if (!devices[response] || !this.originSrc || this.currentRouteName !== 'playing-view') return;
      this.castTarget = devices[response];
      await this.loadCastSource(this.$store.getters.isImage || pickingSource !== this.originSrc
        ? 0 : videodata.time);
    },
    async loadCastSource(position = 0) {
      if (!this.castTarget) return;
      const source = this.originSrc;
      const requestId = this.castRequest + 1;
      this.castRequest = requestId;
      this.castSource = source;
      this.castPreparing = true;
      this.castAdvanceRequested = false;
      this.castPendingStatus = null;
      this.$store.commit(videoMutations.CASTING_UPDATE, true);
      this.$store.commit(videoMutations.CAST_PAUSED_UPDATE, false);
      const currentTime = Number.isFinite(position) ? Math.max(0, position) : 0;
      videodata.time = currentTime;
      this.$store.commit(videoMutations.CURRENT_TIME_UPDATE, currentTime);
      this.$store.dispatch(videoActions.PAUSE_VIDEO);
      this.$bus.$emit('cast-media-loading', source);
      const current = () => this.castRequest === requestId && this.originSrc === source
        && !!this.castTarget;
      try {
        if (!source || /^https?:/.test(source)) throw new Error('not-local');
        const result = await ipcRenderer.invoke('cast-start', {
          device: this.castTarget,
          filePath: source,
          requestId,
          cues: this.aiSubtitleCues(),
          currentTime,
          volume: this.muted ? 0 : Math.min(1, this.volume),
        });
        if (!current()) return;
        if (!result.ok) throw new Error(result.reason || 'cast-failed');
        this.castPreparing = false;
        const pendingStatus = this.castPendingStatus;
        this.castPendingStatus = null;
        if (pendingStatus && !pendingStatus.casting) {
          this.onCastStatus(undefined, pendingStatus);
          return;
        }
        if (this.castPaused && !this.$store.getters.isImage) ipcRenderer.send('cast-pause');
        ipcRenderer.send('cast-volume', this.muted ? 0 : Math.min(1, this.volume));
        this.$bus.$emit('cast-media-ready', source);
        if (pendingStatus) this.onCastStatus(undefined, pendingStatus);
      } catch (error) {
        if (!current()) return;
        const reason = error instanceof Error ? error.message : String(error);
        const receiverFailed = this.castPendingStatus && this.castPendingStatus.failed;
        this.stopCasting(!this.castPaused);
        if (reason === 'cast-superseded' && !receiverFailed) return;
        addBubble(reason === 'not-local' ? CAST_NOT_LOCAL
          : reason.indexOf('unsupported-container') === 0 ? CAST_UNSUPPORTED : CAST_FAILED);
      }
    },
    onCastStatus(event: Event | undefined, status: CastStatus) {
      if (!this.castTarget || status.requestId !== this.castRequest
        || status.source !== this.castSource || status.source !== this.originSrc) return;
      if (this.castPreparing) {
        if (!status.casting || (status.ended
          && (!this.castPendingStatus || this.castPendingStatus.casting))) {
          this.castPendingStatus = status;
        }
        return;
      }
      if (!status.casting) {
        this.stopCasting(!this.castPaused);
        if (status.failed) addBubble(CAST_FAILED);
        return;
      }
      // A still image's pause control belongs to the slideshow clock.
      if (this.$store.getters.isImage) return;
      this.$store.commit(videoMutations.CAST_PAUSED_UPDATE, !!status.paused);
      if (Number.isFinite(status.currentTime)) {
        videodata.time = status.currentTime;
        this.$store.commit(videoMutations.CURRENT_TIME_UPDATE, status.currentTime);
      }
      if (Number.isFinite(status.duration) && status.duration > 0) {
        this.$store.commit(videoMutations.DURATION_UPDATE, status.duration);
      }
      this.$bus.$emit('cast-tick');
      if (status.ended && !this.castAdvanceRequested) {
        this.castAdvanceRequested = true;
        if (this.singleCycle || this.$store.getters.nextVideo === ''
          || this.$store.getters.nextVideo === this.originSrc) this.loadCastSource(0);
        else this.$bus.$emit('next-video');
      }
    },
  },
};
