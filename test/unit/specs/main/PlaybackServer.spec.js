import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import {
  buildVirtualMp4,
  parseByteRange,
  patchFragmentedMp4Duration,
  PlaybackServer,
  shouldUsePlaybackServer,
} from '@/../main/helpers/PlaybackServer';

function request(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (response) => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        body: Buffer.concat(chunks),
        headers: response.headers,
        statusCode: response.statusCode,
      }));
    }).on('error', reject);
  });
}

function fragmentedMp4Fixture() {
  const fixture = Buffer.alloc(128);
  fixture.writeUInt32BE(8, 0);
  fixture.write('ftyp', 4, 4, 'ascii');
  fixture.writeUInt32BE(32, 8);
  fixture.write('moov', 12, 4, 'ascii');
  fixture.writeUInt32BE(24, 16);
  fixture.write('stco', 20, 4, 'ascii');
  fixture.writeUInt32BE(2, 28);
  fixture.writeUInt32BE(64, 32);
  fixture.writeUInt32BE(96, 36);
  fixture.writeUInt32BE(32, 56);
  fixture.write('mdat', 60, 4, 'ascii');
  fixture.writeUInt32BE(40, 88);
  fixture.write('mdat', 92, 4, 'ascii');
  return fixture;
}

function fragmentedMp4InitFixture() {
  const fixture = Buffer.alloc(152);
  fixture.writeUInt32BE(8, 0);
  fixture.write('ftyp', 4, 4, 'ascii');
  fixture.writeUInt32BE(144, 8);
  fixture.write('moov', 12, 4, 'ascii');
  fixture.writeUInt32BE(32, 16);
  fixture.write('mvhd', 20, 4, 'ascii');
  fixture.writeUInt32BE(1000, 36);
  fixture.writeUInt32BE(104, 48);
  fixture.write('trak', 52, 4, 'ascii');
  fixture.writeUInt32BE(40, 56);
  fixture.write('tkhd', 60, 4, 'ascii');
  fixture.writeUInt32BE(56, 96);
  fixture.write('mdia', 100, 4, 'ascii');
  fixture.writeUInt32BE(32, 104);
  fixture.write('mdhd', 108, 4, 'ascii');
  fixture.writeUInt32BE(48000, 124);
  fixture.writeUInt32BE(16, 136);
  fixture.write('free', 140, 4, 'ascii');
  return fixture;
}

describe('PlaybackServer', () => {
  let filePath;
  let server;

  beforeEach(() => {
    filePath = path.join(os.tmpdir(), `splayer-playback-${Date.now()}-${Math.random()}.mp4`);
    fs.writeFileSync(filePath, Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz'));
    server = new PlaybackServer();
  });

  afterEach(async () => {
    await server.close();
    fs.unlinkSync(filePath);
  });

  it('serves exact HTTP byte ranges', async () => {
    const url = await server.urlFor(filePath);
    const response = await request(url, { Range: 'bytes=10-15' });

    expect(response.statusCode).to.equal(206);
    expect(response.headers['content-range']).to.equal('bytes 10-15/36');
    expect(response.body.toString()).to.equal('abcdef');
  });

  it('serves the whole file without a range header', async () => {
    const url = await server.urlFor(filePath);
    const response = await request(url);

    expect(response.statusCode).to.equal(200);
    expect(response.body.toString()).to.equal('0123456789abcdefghijklmnopqrstuvwxyz');
  });

  it('serves fragmented MP4 blocks as one contiguous ranged file', async () => {
    fs.writeFileSync(filePath, fragmentedMp4Fixture());
    const url = await server.urlFor(filePath);
    const response = await request(url, { Range: 'bytes=0-' });

    expect(response.statusCode).to.equal(206);
    expect(response.headers['content-range']).to.equal('bytes 0-119/120');
    expect(response.body.length).to.equal(120);
    expect(response.body.readUInt32BE(36)).to.equal(88);
    expect(response.body.slice(56, 64).toString('hex')).to.equal('000000406d646174');
  });

  it('parses suffix and open-ended ranges', () => {
    expect(parseByteRange('bytes=5-', 20)).to.deep.equal({ start: 5, end: 19 });
    expect(parseByteRange('bytes=-5', 20)).to.deep.equal({ start: 15, end: 19 });
    expect(parseByteRange('bytes=20-', 20)).to.equal(null);
  });

  it('uses the virtual server only for mounted MP4-family files', () => {
    expect(shouldUsePlaybackServer('/Volumes/Videos/movie.mp4')).to.equal(true);
    expect(shouldUsePlaybackServer('/Volumes/Videos/movie.mkv')).to.equal(false);
    expect(shouldUsePlaybackServer('/Volumes/Videos/movie.webm')).to.equal(false);
  });

  it('returns a seekable compatibility stream URL for Matroska remuxing', async () => {
    const url = await server.compatibilityUrlFor(filePath, 6395.639, '/bin/false');

    expect(url).to.match(/^http:\/\/127\.0\.0\.1:\d+\/compat\/[a-f0-9]{40}\//);
    expect(url).to.contain('.mp4?start=0');
  });

  it('writes the complete movie duration into fragmented MP4 track headers', () => {
    const patched = patchFragmentedMp4Duration(fragmentedMp4InitFixture(), 12.5);

    expect(patched.readUInt32BE(40)).to.equal(12500);
    expect(patched.readUInt32BE(84)).to.equal(12500);
    expect(patched.readUInt32BE(128)).to.equal(600000);
  });

  it('builds a contiguous virtual MP4 from fragmented media blocks', () => {
    const prefix = fragmentedMp4Fixture();

    const virtual = buildVirtualMp4(prefix, 128);
    expect(virtual.size).to.equal(120);
    expect(virtual.prefix.readUInt32BE(32)).to.equal(64);
    expect(virtual.prefix.readUInt32BE(36)).to.equal(88);
    expect(virtual.prefix.slice(56, 64).toString('hex')).to.equal('000000406d646174');
    expect(virtual.chunks).to.deep.equal([
      {
        originalStart: 64, originalEnd: 87, virtualStart: 64, virtualEnd: 87,
      },
      {
        originalStart: 96, originalEnd: 127, virtualStart: 88, virtualEnd: 119,
      },
    ]);
  });
});
