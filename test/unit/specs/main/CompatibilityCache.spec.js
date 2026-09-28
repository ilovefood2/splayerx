import fs from 'fs';
import os from 'os';
import path from 'path';
import { pruneCompatibilityCache, transportStreamPlan } from '@/../main/helpers/mediaTasksPlugin';

describe('compatibility remux cache', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.UTC(2026, 8, 28);
  let directory;

  function file(name, bytes, ageMs) {
    const target = path.join(directory, name);
    fs.writeFileSync(target, Buffer.alloc(bytes));
    const time = new Date(now - ageMs);
    fs.utimesSync(target, time, time);
    return target;
  }
  const exists = name => fs.existsSync(path.join(directory, name));

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'splayer-compat-test-'));
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('deletes partial remuxes abandoned by an earlier run but keeps one in flight', async () => {
    file('a.mp4.4242.partial.mp4', 10, 0);
    file('b.mp4.777.partial.mp4', 10, 0);

    await pruneCompatibilityCache(directory, { now, pid: 777 });

    expect(exists('a.mp4.4242.partial.mp4')).to.equal(false);
    expect(exists('b.mp4.777.partial.mp4')).to.equal(true);
  });

  it('expires stale copies and keeps recently used ones', async () => {
    file('stale.mp4', 10, 8 * DAY);
    file('recent.mp4', 10, 1 * DAY);
    file('unrelated.txt', 10, 30 * DAY);

    await pruneCompatibilityCache(directory, { now, pid: 1 });

    expect(exists('stale.mp4')).to.equal(false);
    expect(exists('recent.mp4')).to.equal(true);
    expect(exists('unrelated.txt')).to.equal(true);
  });

  it('evicts least recently used copies beyond the size budget', async () => {
    file('newest.mp4', 40, 1000);
    file('middle.mp4', 40, 2000);
    file('oldest.mp4', 40, 3000);

    await pruneCompatibilityCache(directory, { now, pid: 1, maxBytes: 100 });

    expect(exists('newest.mp4')).to.equal(true);
    expect(exists('middle.mp4')).to.equal(true);
    expect(exists('oldest.mp4')).to.equal(false);
  });

  it('does nothing when the cache directory does not exist yet', async () => {
    await pruneCompatibilityCache(path.join(directory, 'missing'), { now });
  });
});

describe('transport stream playback plan', () => {
  const probe = (video, ...audio) => ({
    format: { duration: '1800' },
    streams: [
      { codec_type: 'video', codec_name: video },
      ...audio.map(codec => ({ codec_type: 'audio', codec_name: codec })),
    ],
  });

  it('copies a local H.264/AAC recording losslessly', () => {
    expect(transportStreamPlan('/Users/me/Movies/show.ts', probe('h264', 'aac'))).to.equal('remux');
    expect(transportStreamPlan('/Users/me/Movies/silent.ts', probe('h264'))).to.equal('remux');
  });

  it('streams codecs Chromium cannot decode instead of copying them', () => {
    // Broadcast MPEG-2 video, or AC-3/MP2 audio next to a playable track.
    expect(transportStreamPlan('/Users/me/Movies/dvb.ts', probe('mpeg2video', 'mp2'))).to.equal('stream');
    expect(transportStreamPlan('/Users/me/Movies/atsc.ts', probe('h264', 'aac', 'ac3'))).to.equal('stream');
  });

  it.runIf(process.platform === 'darwin')('starts network recordings immediately instead of copying them first', () => {
    expect(transportStreamPlan('/Volumes/Share/show.ts', probe('h264', 'aac'))).to.equal('stream');
  });
});
