import fs from 'fs';
import os from 'os';
import path from 'path';
import { getAllValidVideo } from '../../../../src/main/helpers/openFiles';
import { MEDIA_SCAN_DIRECTORY_LIMIT } from '../../../../src/shared/utils';

describe('opening folders from Finder or the Dock', () => {
  let root;

  const touch = (...parts) => {
    const target = path.join(root, ...parts);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '');
    return target;
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'splayer-open-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('finds media in nested folders', () => {
    const episode = touch('Show', 'Season 1', 'E01.mkv');
    const movie = touch('Show', 'movie.mp4');
    touch('Show', 'notes.txt');

    const files = getAllValidVideo(true, [path.join(root, 'Show')]);

    expect(files).to.have.members([episode, movie]);
  });

  it('keeps playable files when another entry cannot be read', () => {
    const movie = touch('Movies', 'movie.mp4');
    // A dangling link used to make the whole open return nothing.
    fs.symlinkSync(path.join(root, 'gone'), path.join(root, 'Movies', 'broken'));

    const files = getAllValidVideo(true, [path.join(root, 'Movies')]);

    expect(files).to.deep.equal([movie]);
  });

  it('never descends into macOS packages or nested hidden folders', () => {
    const movie = touch('Movies', 'movie.mp4');
    touch('Movies', 'Photos Library.photoslibrary', 'originals', 'clip.mov');
    touch('Movies', 'Player.app', 'Contents', 'Resources', 'intro.mp4');
    touch('Movies', '.cache', 'preview.mp4');

    const files = getAllValidVideo(true, [path.join(root, 'Movies')]);

    expect(files).to.deep.equal([movie]);
  });

  it('still scans a hidden folder the user opened explicitly', () => {
    const clip = touch('.private', 'clip.mp4');

    expect(getAllValidVideo(true, [path.join(root, '.private')])).to.deep.equal([clip]);
  });

  it('reads a bounded number of folders from a huge tree', () => {
    // More folders than the budget: the walk must stop, not read them all.
    const folders = MEDIA_SCAN_DIRECTORY_LIMIT + 44;
    const first = touch('d000', 'clip.mp4');
    for (let i = 1; i < folders; i += 1) touch(`d${String(i).padStart(3, '0')}`, 'clip.mp4');
    const readdir = vi.spyOn(fs, 'readdirSync');

    try {
      const files = getAllValidVideo(true, [root]);
      expect(files).to.include(first);
      expect(files.length).to.be.below(folders);
      expect(readdir.mock.calls.length).to.be.at.most(MEDIA_SCAN_DIRECTORY_LIMIT);
    } finally {
      readdir.mockRestore();
    }
  });

  it('pairs a subtitle with its video without re-reading the folder per subtitle', () => {
    touch('Show', 'E01.mkv');
    for (let i = 0; i < 30; i += 1) touch('Show', `E01.lang${i}.srt`);
    touch('Show', 'E01.srt');
    const readdir = vi.spyOn(fs, 'readdirSync');

    try {
      getAllValidVideo(true, [path.join(root, 'Show')]);
      const showReads = readdir.mock.calls.filter(([dir]) => dir === path.join(root, 'Show'));
      expect(showReads).to.have.length(1);
    } finally {
      readdir.mockRestore();
    }
  });
});
