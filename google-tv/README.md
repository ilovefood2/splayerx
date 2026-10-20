# SPlayer for Google TV

This module is a native, remote-first Android TV application. It is separate
from the Electron desktop runtime and produces an APK that can be sideloaded
on Google TV.

## Network locations

The home screen saves SMB, WebDAV, and direct HTTP/HTTPS locations as
favorites. SMB folders are read with SMB2/3 support. HTTP folders are browsed
with WebDAV `PROPFIND`; direct HTTP video URLs open immediately.

Folder listings are fetched off the UI thread, coalesced when the same request
is already running, and cached for 30 seconds. Refresh bypasses the cache.

Credentials are optional and stay in the application's private preferences on
the TV. They are never sent anywhere except the selected network server.

## Remote controls and deleting files

The saved location is focused at launch. Open it with OK. Favorites are hidden
while browsing to give the file list more room; Back returns to the parent folder.
Hold OK on a favorite to edit its address/login or remove the shortcut.

Choose **Select files**, or hold OK on a video, to enter selection mode. OK
toggles a file, **Select all** selects the current folder's video files, and
**Delete (n)** asks for confirmation. Back cancels selection. Folders cannot be
selected for deletion. A failed batch reports each failed filename and keeps
those files selected for retry.

During playback, OK opens controls with the filename, playback position,
play/pause, 10-second seeking, and **Delete file**. The read handle is closed
before deleting the playing file. After success the folder is refreshed.
Every deletion confirmation starts on **Cancel**. Deletion is permanent and
requires write permission on the SMB share or HTTP/WebDAV server.

## Build and install

Requirements:

- JDK 17
- Android SDK platform 35 and build tools 35.0.0

From the repository root:

```sh
npm run build:google-tv
```

The installable, debug-signed APK is written to:

```text
build/SPlayer-GoogleTV-<version>.apk
```

With Google TV developer options and network debugging enabled:

```sh
adb connect <google-tv-address>
adb install -r build/SPlayer-GoogleTV-<version>.apk
```
