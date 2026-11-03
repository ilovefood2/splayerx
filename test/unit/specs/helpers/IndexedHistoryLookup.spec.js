import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteDB, openDB } from 'idb';
import { InfoDB } from '@/helpers/infoDB';

describe('indexed playback history lookup', () => {
  let db;
  let history;
  const name = 'SPlayer-indexed-history-regression';

  beforeEach(async () => {
    db = await openDB(name, 1, {
      upgrade(database) {
        const store = database.createObjectStore('media-item', { keyPath: 'videoId' });
        store.createIndex('path', 'path');
        store.createIndex('source', 'source');
        store.createIndex('lastPlayedTime', 'lastPlayedTime');
      },
    });
    const tx = db.transaction('media-item', 'readwrite');
    await Promise.all([
      tx.store.put({ videoId: 1, path: '/wanted.mp4', source: 'playlist', lastPlayedTime: 0 }),
      tx.store.put({ videoId: 2, path: '/wanted.mp4', source: '', lastPlayedTime: 10 }),
      tx.store.put({
        videoId: 3, path: '/unrelated.mp4', source: '', lastPlayedTime: 20,
        shortCut: 'large unrelated thumbnail'.repeat(4096),
      }),
      tx.done,
    ]);
    history = new InfoDB();
    vi.spyOn(history, 'getDB').mockResolvedValue(db);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    db.close();
    await deleteDB(name);
  });

  it('reads only the requested path and never scans unrelated thumbnail records', async () => {
    const scan = vi.spyOn(IDBIndex.prototype, 'openCursor');
    const records = await history.getAllValueByIndex('media-item', 'path', '/wanted.mp4');
    expect(records.map(record => record.videoId)).toEqual([1, 2]);
    expect(records.every(record => !record.shortCut)).toBe(true);
    expect(scan).not.toHaveBeenCalled();
    await expect(history.getAllValueByIndex('media-item', 'path', '/missing.mp4')).resolves.toEqual([]);
  });

  it('preserves empty-string and zero index keys', async () => {
    const singles = await history.getAllValueByIndex('media-item', 'source', '');
    expect(singles.map(record => record.videoId)).toEqual([2, 3]);
    const unplayed = await history.getAllValueByIndex('media-item', 'lastPlayedTime', 0);
    expect(unplayed.map(record => record.videoId)).toEqual([1]);
  });
});
