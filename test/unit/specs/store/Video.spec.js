import Video from '@/store/modules/Video';
import { Video as videoActions, Subtitle as subtitleActions } from '@/store/actionTypes';
import { Video as videoMutations } from '@/store/mutationTypes';
import { vi } from 'vitest';
import { ipcRenderer } from 'electron';

describe('store/modules/Video', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function playbackContext() {
    const state = Video.state();
    return {
      state,
      commit: (type, payload) => Video.mutations[type](state, payload),
      dispatch: vi.fn(),
    };
  }

  it('discards a prepared source when a newer video has been selected', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    let finishPreparation;
    vi.spyOn(ipcRenderer, 'invoke').mockReturnValue(new Promise((resolve) => {
      finishPreparation = resolve;
    }));
    const context = playbackContext();
    context.state.paused = true;
    const opening = Video.actions.SRC_SET(context, {
      src: '/videos/slow.ts', id: 1, mediaHash: 'old-hash',
    });
    await Video.actions.SRC_SET(context, {
      src: '/videos/latest.mp4', id: 2, mediaHash: 'new-hash',
    });
    finishPreparation('/cache/slow.mp4');

    expect(await opening).to.equal(undefined);
    expect(context.state.src).to.equal('/videos/latest.mp4');
    expect(context.state.id).to.equal(2);
    expect(context.state.mediaHash).to.equal('new-hash');
    expect(context.state.paused).to.equal(false);
  });

  it('ignores a stale failure after a newer source succeeds', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    let failPreparation;
    vi.spyOn(ipcRenderer, 'invoke').mockReturnValue(new Promise((resolve, reject) => {
      failPreparation = reject;
    }));
    const context = playbackContext();
    const opening = Video.actions.SRC_SET(context, { src: '/videos/slow.ts', id: 1 });
    await Video.actions.SRC_SET(context, {
      src: '/videos/latest.mp4', id: 2, mediaHash: 'new-hash',
    });
    failPreparation(new Error('Disconnected share'));

    expect(await opening).to.equal(undefined);
    expect(context.state.src).to.equal('/videos/latest.mp4');
  });

  it('invalidates preparation when playback is cleared', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    let finishPreparation;
    vi.spyOn(ipcRenderer, 'invoke').mockReturnValue(new Promise((resolve) => {
      finishPreparation = resolve;
    }));
    const context = playbackContext();
    const opening = Video.actions.SRC_SET(context, {
      src: '/videos/slow.mkv', id: 1, mediaHash: 'old-hash',
    });
    await Video.actions.SRC_SET(context, { src: '', id: NaN, mediaHash: '' });
    finishPreparation('/cache/slow.mp4');

    expect(await opening).to.equal(undefined);
    expect(context.state.src).to.equal('');
    expect(context.state.currentSrc).to.equal('');
    expect(context.dispatch).not.toHaveBeenCalled();
  });

  it('keeps independent preparation requests for separate player stores', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    let finishPreparation;
    vi.spyOn(ipcRenderer, 'invoke').mockReturnValue(new Promise((resolve) => {
      finishPreparation = resolve;
    }));
    const first = playbackContext();
    const second = playbackContext();
    const opening = Video.actions.SRC_SET(first, {
      src: '/videos/slow.ts', id: 1, mediaHash: 'first-hash',
    });
    await Video.actions.SRC_SET(second, {
      src: '/videos/other.mp4', id: 2, mediaHash: 'second-hash',
    });
    finishPreparation('/cache/slow.mp4');

    expect(await opening).to.equal('first-hash');
    expect(first.state.src).to.equal('/videos/slow.ts');
    expect(second.state.src).to.equal('/videos/other.mp4');
  });

  it('creates independent playback state for each player window', () => {
    const firstWindow = Video.state();
    const secondWindow = Video.state();

    Video.mutations[videoMutations.VOLUME_UPDATE](firstWindow, 35);
    Video.mutations[videoMutations.MUTED_UPDATE](firstWindow, true);

    expect(firstWindow.volume).to.equal(35);
    expect(firstWindow.muted).to.equal(true);
    expect(secondWindow.volume).to.equal(100);
    expect(secondWindow.muted).to.equal(false);
  });

  it('preserves HTTP playback URLs', () => {
    const url = 'http://127.0.0.1:54321/media/token/movie.mp4';
    expect(Video.getters.convertedSrc({ currentSrc: url, src: '/Volumes/movie.mp4' }))
      .to.equal(url);
  });

  it('assigns a normal media source before calculating its hash', async () => {
    const state = { src: '' };
    const commits = [];
    const dispatches = [];
    const commit = (type, payload) => {
      commits.push([type, payload]);
      if (type === videoMutations.SRC_UPDATE) state.src = payload;
    };
    const dispatch = (type, payload) => dispatches.push([type, payload]);
    const src = './test/assets/test.avi';

    const opening = Video.actions[videoActions.SRC_SET](
      { state, commit, dispatch },
      { src, id: 7 },
    );

    expect(commits).to.deep.equal([
      [videoMutations.CURRENT_SRC_UPDATE, src],
      [videoMutations.MEDIA_HASH_UPDATE, ''],
      [videoMutations.ID_UPDATE, 7],
      [videoMutations.PAUSED_UPDATE, false],
      [videoMutations.SRC_UPDATE, src],
    ]);
    expect(dispatches).to.deep.equal([
      [subtitleActions.INITIALIZE_VIDEO_SUBTITLE_MAP, { videoSrc: src }],
    ]);

    const mediaHash = await opening;
    expect(mediaHash).to.be.a('string').and.not.equal('');
    expect(commits[commits.length - 1]).to.deep.equal([
      videoMutations.MEDIA_HASH_UPDATE,
      mediaHash,
    ]);
  });
});
