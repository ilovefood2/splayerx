/**
 * Expand paths opened from Finder, the Dock or the command line into the media
 * files to play.
 *
 * This runs synchronously on the main process (callers are synchronous), so it
 * must stay bounded: every window waits while it runs.
 */

import fs from 'fs';
import path, {
  basename, dirname, extname, join,
} from 'path';
import { uniq } from 'lodash';
import {
  isAudio, isImage, isSubtitle, isVideo,
  MEDIA_SCAN_DIRECTORY_LIMIT, PACKAGE_DIRECTORY,
} from '../../shared/utils';

export function searchSubsInDir(dir) {
  const dirFiles = fs.readdirSync(dir);
  return dirFiles
    .filter(subtitleFilename => isSubtitle(subtitleFilename))
    .map(subtitleFilename => (join(dir, subtitleFilename)));
}
function searchForLocalVideo(subSrc, readDirectory = dir => fs.readdirSync(dir)) {
  const videoDir = dirname(subSrc);
  const videoBasename = basename(subSrc, extname(subSrc)).toLowerCase();
  const videoFilename = basename(subSrc).toLowerCase();
  const dirFiles = readDirectory(videoDir);
  return dirFiles
    .filter((subtitleFilename) => {
      const lowerCasedName = subtitleFilename.toLowerCase();
      return (
        isVideo(lowerCasedName) // TODO: audio
        && lowerCasedName.slice(0, lowerCasedName.lastIndexOf('.')) === videoBasename
        && lowerCasedName !== videoFilename && !isSubtitle(lowerCasedName)
      );
    })
    .map(subtitleFilename => (join(videoDir, subtitleFilename)));
}
export function getAllValidVideo(onlySubtitle, files) {
  try {
    const videoFiles = [];
    // Opening a folder from Finder or the Dock expands it here, synchronously
    // on the main process, so every window waits for it. Bound the walk the
    // same way as the renderer's folder scan: a home folder or share root used
    // to be read in full before anything played.
    let directoryBudget = MEDIA_SCAN_DIRECTORY_LIMIT;
    const inputCount = files.length;
    // Each subtitle looks for its video among its siblings; read every
    // directory once rather than once per subtitle file in it.
    const listings = new Map();
    const readDirectory = (dir) => {
      if (!listings.has(dir)) {
        try {
          listings.set(dir, fs.readdirSync(dir));
        } catch (ex) {
          listings.set(dir, []);
        }
      }
      return listings.get(dir);
    };

    for (let i = 0; i < files.length; i += 1) {
      // The extension already tells us that this is a file. Avoid a blocking
      // metadata round trip for known media paths, which can stall Electron's
      // main process when the path is on a slow or reconnecting network mount.
      if (isSubtitle(files[i]) || isVideo(files[i])
        || isAudio(files[i]) || isImage(files[i])) continue;
      const name = path.basename(files[i]);
      // Hidden folders are skipped only when nested; one the user opened
      // explicitly is still scanned.
      if ((i >= inputCount && name.startsWith('.')) || PACKAGE_DIRECTORY.test(name)) continue;
      if (directoryBudget > 0) {
        try {
          if (fs.statSync(files[i]).isDirectory()) {
            directoryBudget -= 1;
            const dirPath = files[i];
            files.push(...readDirectory(dirPath).map(file => path.join(dirPath, file)));
          }
        } catch (ex) {
          // One unreadable entry (a broken link, no permission) must not
          // discard every playable file found alongside it.
        }
      }
    }
    if (!process.mas) {
      files.forEach((tempFilePath) => {
        const baseName = path.basename(tempFilePath);
        if (baseName.startsWith('.')) return;
        if (isSubtitle((tempFilePath))) {
          const tempVideo = searchForLocalVideo(tempFilePath, readDirectory);
          videoFiles.push(...tempVideo);
        } else if (isVideo(tempFilePath) || isAudio(tempFilePath) || isImage(tempFilePath)) {
          videoFiles.push(tempFilePath);
        }
      });
    } else {
      files.forEach((tempFilePath) => {
        const baseName = path.basename(tempFilePath);
        if (baseName.startsWith('.')) return;
        if (isVideo(tempFilePath) || isAudio(tempFilePath) || isImage(tempFilePath)) {
          videoFiles.push(tempFilePath);
        }
      });
    }
    return uniq(videoFiles);
  } catch (ex) {
    return [];
  }
}
