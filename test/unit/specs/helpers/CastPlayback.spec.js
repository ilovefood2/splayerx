import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ipcRenderer } from 'electron';
import { castPlayback } from '@/helpers/castPlayback';
import { videodata } from '@/store/video';
import { addBubble } from '@/helpers/notificationControl';
import { Video as mutations } from '@/store/mutationTypes';
import { Video as actions } from '@/store/actionTypes';

vi.mock('@/helpers/notificationControl', () => ({ addBubble: vi.fn() }));

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function player() {
  const context = {
    ...castPlayback.data(),
    ...castPlayback.methods,
    originSrc: '/library/first.mp4',
    casting: false,
    castPaused: false,
    paused: false,
    volume: 1,
    muted: false,
    currentRouteName: 'playing-view',
    singleCycle: false,
    aiSubtitleCues: () => [],
    $t: key => key,
    $electron: { remote: { dialog: { showMessageBox: vi.fn().mockResolvedValue({ response: 0 }) } } },
    $bus: { $emit: vi.fn() },
  };
  context.$store = {
    getters: { isImage: false },
    commit: vi.fn((type, value) => {
      if (type === mutations.CASTING_UPDATE) context.casting = value;
      if (type === mutations.CAST_PAUSED_UPDATE) context.castPaused = value;
    }),
    dispatch: vi.fn((type) => {
      if (type === actions.PAUSE_VIDEO) context.paused = true;
      if (type === actions.PLAY_VIDEO) context.paused = false;
    }),
  };
  return context;
}

const device = { id: 'tv', name: 'TV', host: 'tv.local', port: 8009 };
const status = (context, changes = {}) => ({
  source: context.castSource, requestId: context.castRequest,
  casting: true, currentTime: 15, duration: 60, paused: false, ended: false,
  ...changes,
});

describe('cast playlist handoff', () => {
  beforeEach(() => {
    vi.spyOn(ipcRenderer, 'invoke').mockResolvedValue({ ok: true });
    vi.spyOn(ipcRenderer, 'send').mockImplementation(() => {});
    addBubble.mockClear();
    videodata.time = 12;
  });
  afterEach(() => vi.restoreAllMocks());

  it('loads each following file on the selected TV without reopening the picker', async () => {
    const p = player();
    p.castTarget = device;
    await p.loadCastSource(12);
    p.originSrc = '/library/next.mp4';
    castPlayback.watch.originSrc.call(p, p.originSrc);
    await vi.waitFor(() => expect(p.castPreparing).toBe(false));

    expect(ipcRenderer.invoke).toHaveBeenCalledTimes(2);
    expect(ipcRenderer.invoke).toHaveBeenLastCalledWith('cast-start', expect.objectContaining({
      device, filePath: p.originSrc, currentTime: 0, requestId: 2,
    }));
    expect(p.casting).toBe(true);
    expect(p.paused).toBe(true);
    expect(p.$bus.$emit).toHaveBeenCalledWith('cast-media-ready', p.originSrc);
    expect(p.$electron.remote.dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('ignores an old successful cast after switching to another file', async () => {
    const p = player();
    const first = deferred();
    const next = deferred();
    ipcRenderer.invoke.mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise);
    p.castTarget = device;
    const older = p.loadCastSource();
    const oldStatus = status(p);
    p.originSrc = '/library/next.mp4';
    const latest = p.loadCastSource();
    next.resolve({ ok: false, reason: 'network-error' });
    await latest;
    expect(p.paused).toBe(false);
    expect(p.casting).toBe(false);
    p.$store.dispatch.mockClear();
    first.resolve({ ok: true });
    await older;
    p.onCastStatus({}, oldStatus);
    expect(p.paused).toBe(false);
    expect(p.$store.dispatch).not.toHaveBeenCalled();
  });

  it('cancels an in-flight load without allowing its result to start casting again', async () => {
    const p = player();
    const pending = deferred();
    ipcRenderer.invoke.mockReturnValue(pending.promise);
    p.castTarget = device;
    const loading = p.loadCastSource();
    p.stopCasting();
    pending.resolve({ ok: true });
    await loading;
    expect(p.casting).toBe(false);
    expect(p.castTarget).toBeNull();
    expect(ipcRenderer.send).toHaveBeenCalledWith('cast-stop', { requestId: 1 });
    expect(p.$bus.$emit).not.toHaveBeenCalledWith('cast-media-ready', p.originSrc);
  });

  it('advances once only for the current receiver completion and loops on the same TV', async () => {
    const p = player();
    p.castTarget = device;
    await p.loadCastSource();
    p.$bus.$emit.mockClear();
    p.onCastStatus({}, status(p, { ended: true, requestId: 0 }));
    p.onCastStatus({}, status(p, { ended: true, source: '/wrong.mp4' }));
    expect(p.$bus.$emit).not.toHaveBeenCalled();
    p.onCastStatus({}, status(p, { ended: true }));
    p.onCastStatus({}, status(p, { ended: true }));
    expect(p.$bus.$emit.mock.calls.filter(([event]) => event === 'next-video')).toHaveLength(1);
    p.castAdvanceRequested = false;
    p.singleCycle = true;
    p.onCastStatus({}, status(p, { ended: true }));
    await vi.waitFor(() => expect(p.castPreparing).toBe(false));
    expect(ipcRenderer.invoke).toHaveBeenLastCalledWith('cast-start', expect.objectContaining({
      filePath: p.originSrc, currentTime: 0, requestId: 2,
    }));
  });

  it('leaves image timing and pause state to the slideshow', async () => {
    const p = player();
    p.originSrc = '/library/photo.jpg';
    p.$store.getters.isImage = true;
    p.castTarget = device;
    await p.loadCastSource();
    p.$bus.$emit.mockClear();
    p.onCastStatus({}, status(p, { paused: true, ended: true, currentTime: 90 }));
    expect(p.castPaused).toBe(false);
    expect(videodata.time).toBe(0);
    expect(p.$bus.$emit).not.toHaveBeenCalled();
  });

  it('restarts a single-item playlist loop on the receiver instead of seeking to its end', async () => {
    const p = player();
    p.castTarget = device;
    p.$store.getters.nextVideo = '';
    await p.loadCastSource();
    p.$bus.$emit.mockClear();
    p.onCastStatus({}, status(p, { ended: true }));
    await vi.waitFor(() => expect(p.castPreparing).toBe(false));
    expect(p.$bus.$emit).not.toHaveBeenCalledWith('next-video');
    expect(ipcRenderer.invoke).toHaveBeenLastCalledWith('cast-start', expect.objectContaining({
      filePath: p.originSrc, currentTime: 0, requestId: 2,
    }));
  });

  it('preserves a pause made while the next video is preparing', async () => {
    const p = player();
    const pending = deferred();
    ipcRenderer.invoke.mockReturnValue(pending.promise);
    p.castTarget = device;
    const loading = p.loadCastSource();
    p.castPaused = true;
    p.onCastStatus({}, status(p));
    expect(p.castPaused).toBe(true);
    pending.resolve({ ok: true });
    await loading;
    expect(ipcRenderer.send).toHaveBeenCalledWith('cast-pause');
    expect(p.paused).toBe(true);
  });

  it('casts the current file if the playlist moved while the device picker was open', async () => {
    const p = player();
    const picker = deferred();
    ipcRenderer.invoke.mockResolvedValueOnce([device]).mockResolvedValueOnce({ ok: true });
    p.$electron.remote.dialog.showMessageBox.mockReturnValue(picker.promise);
    const selecting = p.castToDevice();
    await vi.waitFor(() => expect(p.$electron.remote.dialog.showMessageBox).toHaveBeenCalled());
    p.originSrc = '/library/later.mp4';
    picker.resolve({ response: 0 });
    await selecting;
    expect(ipcRenderer.invoke).toHaveBeenLastCalledWith('cast-start', expect.objectContaining({
      filePath: p.originSrc, currentTime: 0,
    }));
  });

  it('handles a receiver failure arriving before the successful LOAD reply', async () => {
    const p = player();
    const pending = deferred();
    ipcRenderer.invoke.mockReturnValue(pending.promise);
    p.castTarget = device;
    const loading = p.loadCastSource();
    p.onCastStatus({}, status(p, { casting: false, failed: true }));
    pending.resolve({ ok: true });
    await loading;
    expect(p.castTarget).toBeNull();
    expect(p.casting).toBe(false);
    expect(p.paused).toBe(false);
    expect(p.$bus.$emit).not.toHaveBeenCalledWith('cast-media-ready', p.originSrc);
  });

  it('unlocks the canvas before advancing a video that finished during LOAD', async () => {
    const p = player();
    const pending = deferred();
    ipcRenderer.invoke.mockReturnValue(pending.promise);
    p.castTarget = device;
    const loading = p.loadCastSource();
    p.onCastStatus({}, status(p, { ended: true }));
    p.$bus.$emit.mockClear();
    pending.resolve({ ok: true });
    await loading;
    const events = p.$bus.$emit.mock.calls.map(([event]) => event);
    expect(events.indexOf('cast-media-ready')).toBeLessThan(events.indexOf('next-video'));
    expect(events.filter(event => event === 'next-video')).toHaveLength(1);
  });

  it.each([false, true])('falls back locally after a receiver error, preserving paused intent: %s', async (paused) => {
    const p = player();
    p.castTarget = device;
    await p.loadCastSource();
    p.castPaused = paused;
    p.onCastStatus({}, status(p, { casting: false, failed: true }));
    expect(p.casting).toBe(false);
    expect(p.paused).toBe(paused);
    expect(p.$bus.$emit).toHaveBeenCalledWith('cast-media-stopped', { resume: !paused });
  });
});
