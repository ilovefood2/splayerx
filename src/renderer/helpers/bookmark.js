import { remote } from 'electron';
import syncStorage from '@/helpers/syncStorage';
import { log } from '@/libs/Log';

function resolveBookmarks(files, bookmarks) {
  const data = syncStorage.getSync('bookmark');
  const temp = {};
  files.forEach((file, i) => {
    temp[file] = bookmarks[i];
  });
  syncStorage.setSync('bookmark', { ...data, ...temp });
}

/**
 * Re-establish sandboxed (Mac App Store) access to a folder or file the user
 * granted earlier, using the security-scoped bookmark saved by resolveBookmarks.
 * A no-op off the MAS build or when nothing was bookmarked for the path.
 *
 * Access is held for the session and never explicitly stopped, matching how the
 * rest of the app treats security-scoped folders (see BrowsingView.bookmarkAccessing):
 * the folder stays reachable while its videos are being browsed and played.
 */
function startAccessing(filePath) {
  if (!process.mas) return false;
  const stored = syncStorage.getSync('bookmark') || {};
  if (!Object.prototype.hasOwnProperty.call(stored, filePath)) return false;
  try {
    remote.app.startAccessingSecurityScopedResource(stored[filePath]);
    return true;
  } catch (error) {
    log.warn(`bookmark.startAccessing ${filePath}`, error);
    return false;
  }
}

export default {
  resolveBookmarks,
  startAccessing,
};
