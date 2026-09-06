import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { vi } from 'vitest';
import { createStore } from 'vuex';
import helpers from '@/helpers';
import infoDB from '@/helpers/infoDB';
import { mediaQuickHash } from '@/libs/utils';
import Video from '@/store/modules/Video';
import Playlist from '@/store/modules/Playlist';
import VideoCanvas from '@/containers/VideoCanvas.vue';
import { Subtitle } from '@/store/actionTypes';
import { playInfoStorageService } from '@/services/storage/PlayInfoStorageService';

// Exercise the real app command without bootstrapping main.ts and its windows.
const mainSource = fs.readFileSync('src/renderer/main.ts', 'utf8');
const deleteMethod = mainSource.match(/ {4}async deleteCurrentVideo\(\) \{[\s\S]*?\n {4}},/)[0];
const { deleteCurrentVideo } = vm.runInNewContext(ts.transpileModule(`({${deleteMethod}})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText, { path, log: { error: vi.fn() } });

describe('folder playback history and queue preservation', () => {
  beforeEach(async () => {
    await infoDB.clearAll();
    vi.spyOn(mediaQuickHash, 'try').mockImplementation(async file => `hash:${file}`);
  });

  afterEach(() => vi.restoreAllMocks());

  function playbackContext(incognitoMode = false) {
    const store = createStore({
      getters: { incognitoMode: () => incognitoMode },
      actions: { [Subtitle.INITIALIZE_VIDEO_SUBTITLE_MAP]: () => {} },
      modules: {
        Video,
        Playlist: { ...Playlist, state: () => ({ ...Playlist.state, items: [], playList: [] }) },
      },
    });
    const context = {
      infoDB,
      $store: store,
      $bus: { $emit: vi.fn() },
      $router: { currentRoute: { value: { name: 'playing-view' } }, push: vi.fn() },
      playlistLoop: false,
      switchingLock: false,
      enableVideoInfoStore: false,
      saveSubtitleStyle: vi.fn(),
      savePlaybackStates: vi.fn(),
    };
    ['originSrc', 'videoId', 'playingList', 'items', 'isFolderList', 'playListId',
      'incognitoMode', 'playingIndex'].forEach((key) => {
      Object.defineProperty(context, key, { get: () => store.getters[key] });
    });
    Object.entries(helpers.methods).forEach(([key, method]) => {
      context[key] = method.bind(context);
    });
    ['getCurrentFolderVideos', 'openNextFolderVideo', 'openFolderVideo', 'handleLeaveVideo']
      .forEach((key) => { context[key] = VideoCanvas.methods[key].bind(context); });
    return context;
  }

  it('keeps history IDs and the full queue when advancing through mounted media', async () => {
    const context = playbackContext();
    const files = ['/Volumes/share/first.mp4', '/Volumes/share/sub/second.mp4'];
    await context.createPlayList(...files);

    expect(context.isFolderList).to.equal(true);
    expect(Number.isFinite(context.playListId)).to.equal(true);
    const firstId = context.videoId;
    expect((await infoDB.get('recent-played', context.playListId)).items).to.deep.equal([firstId]);
    await context.openNextFolderVideo();

    expect(context.originSrc).to.equal(files[1]);
    expect(context.playingList).to.deep.equal(files);
    expect(Number.isFinite(context.videoId)).to.equal(true);
    expect(context.items).to.deep.equal([firstId, context.videoId]);
    expect((await infoDB.get('recent-played', context.playListId)).items)
      .to.deep.equal([context.videoId]);
    await playInfoStorageService.updateMediaItemBy(context.videoId, { lastPlayedTime: 25 });
    expect((await infoDB.get('media-item', context.videoId)).lastPlayedTime).to.equal(25);
  });

  it('does not persist private folder playback, including subsequent files', async () => {
    const context = playbackContext(true);
    const files = ['/Volumes/share/private.mp4', '/Volumes/share/sub/next.mp4'];
    await context.createPlayList(...files);
    await context.openNextFolderVideo();
    await context.handleLeaveVideo(context.videoId);

    expect(context.originSrc).to.equal(files[1]);
    expect(context.playingList).to.deep.equal(files);
    expect(await infoDB.getAll('recent-played')).to.deep.equal([]);
    expect(await infoDB.getAll('media-item')).to.deep.equal([]);
  });

  it('does not persist private playback if the user leaves during hashing', async () => {
    const context = playbackContext(true);
    let finishHash;
    mediaQuickHash.try.mockReturnValue(new Promise((resolve) => { finishHash = resolve; }));
    const opening = context.createPlayList('/Volumes/share/private.mp4');
    await context.handleLeaveVideo(context.videoId);
    await context.$store.dispatch('SRC_SET', { src: '', id: NaN, mediaHash: '' });
    finishHash('private-hash');
    await opening;

    expect(await infoDB.getAll('recent-played')).to.deep.equal([]);
    expect(await infoDB.getAll('media-item')).to.deep.equal([]);
  });

  it.each([false, true])('appends folder paths without persisting unplayed files (private: %s)', async (incognitoMode) => {
    const context = playbackContext(incognitoMode);
    const first = '/Volumes/share/first.mp4';
    const next = '/Volumes/share/next.mp4';
    await context.createPlayList(first);
    vi.spyOn(fs.promises, 'stat').mockResolvedValue({ isDirectory: () => false });
    await context.addFiles(next);

    expect(context.originSrc).to.equal(first);
    expect(context.playingList).to.deep.equal([first, next]);
    expect(context.isFolderList).to.equal(true);
    expect(mediaQuickHash.try).toHaveBeenCalledTimes(1);
    expect((await infoDB.getAll('recent-played')).length).to.equal(incognitoMode ? 0 : 1);
  });

  it('retains later subfolders after deleting the current folder item', async () => {
    const context = playbackContext();
    const files = ['/Volumes/share/a.mp4', '/Volumes/share/one/b.mp4', '/Volumes/share/two/c.mp4'];
    await context.createPlayList(...files);
    // This test isolates deletion from the separately tested lazy-folder setup.
    context.$store.commit('isFolderList');
    Object.assign(context, {
      currentRouteName: 'playing-view',
      $t: key => key,
      isLocalVideoPath: () => true,
      removeDeletedVideoFromHistory: vi.fn(),
      menuService: { addRecentPlayItems: vi.fn() },
      $electron: { remote: {
        dialog: { showMessageBox: vi.fn().mockResolvedValue({ response: 0 }) },
        fileSystem: { deleteFile: vi.fn().mockResolvedValue() },
      } },
    });

    await deleteCurrentVideo.call(context);

    expect(context.$electron.remote.fileSystem.deleteFile).toHaveBeenCalledWith(files[0]);
    expect(context.originSrc).to.equal(files[1]);
    expect(context.playingList).to.deep.equal(files.slice(1));
  });
});
