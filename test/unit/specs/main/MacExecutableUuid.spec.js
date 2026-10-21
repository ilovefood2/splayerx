import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { patchMacExecutableUuid } = require('../../../../scripts/after-pack');

describe('macOS executable network identity', () => {
  let directory;
  let file;
  let original;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'splayer-uuid-'));
    file = path.join(directory, 'SPlayer');
    original = Buffer.alloc(104, 0xaa);
    original.writeUInt32LE(0xfeedfacf, 0);
    original.writeUInt32LE(0x100000c, 4);
    original.writeUInt32LE(2, 16);
    original.writeUInt32LE(48, 20);
    original.writeUInt32LE(0x80000028, 32);
    original.writeUInt32LE(24, 36);
    original.writeUInt32LE(0x1b, 56);
    original.writeUInt32LE(24, 60);
    fs.writeFileSync(file, original);
  });

  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('replaces only the UUID bytes and remains stable when packaging again', () => {
    const identity = patchMacExecutableUuid(file, 'org.splayer.splayerx');
    const updated = fs.readFileSync(file);
    expect(updated.subarray(0, 64).equals(original.subarray(0, 64))).to.equal(true);
    expect(updated.subarray(80).equals(original.subarray(80))).to.equal(true);
    expect(updated.subarray(64, 80).equals(original.subarray(64, 80))).to.equal(false);
    expect(patchMacExecutableUuid(file, 'org.splayer.splayerx')).to.equal(identity);
  });

  it('gives different apps and architectures different identities', () => {
    const identity = patchMacExecutableUuid(file, 'org.splayer.splayerx');
    expect(patchMacExecutableUuid(file, 'com.github.Electron')).not.to.equal(identity);
    original.writeUInt32LE(0x1000007, 4);
    fs.writeFileSync(file, original);
    expect(patchMacExecutableUuid(file, 'org.splayer.splayerx')).not.to.equal(identity);
  });

  it.each(['truncated', 'invalid-size', 'missing-uuid', 'unsupported-format'])('rejects %s without modifying the executable', (kind) => {
    if (kind === 'truncated') original.writeUInt32LE(200, 20);
    if (kind === 'invalid-size') original.writeUInt32LE(0, 36);
    if (kind === 'missing-uuid') original.writeUInt32LE(1, 16);
    if (kind === 'unsupported-format') original.writeUInt32LE(0xcafebabe, 0);
    fs.writeFileSync(file, original);
    expect(() => patchMacExecutableUuid(file, 'org.splayer.splayerx')).to.throw();
    expect(fs.readFileSync(file).equals(original)).to.equal(true);
  });
});
