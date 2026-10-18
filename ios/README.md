# SPlayer for iPhone and iPad

Native SwiftUI / AVKit application, requiring iOS 17 or newer. The desktop and
Google TV applications keep their existing runtimes.

## Videos and folders

- In Library, tap **+ → Import Videos** or **Import Folder**. The Files picker
  supports on-device, iCloud Drive, and installed file providers. Folder imports
  copy videos recursively and preserve nested folders; original files stay intact.
- Create folders with **+ → New Folder**. Long-press a video or folder to move it,
  add it to a playlist, or delete it. Folders can also be renamed.
- Videos are local copies, so they work offline after import. Imports need enough
  free device storage and should finish before leaving the app. Duplicate names
  receive a numbered suffix; existing files are never overwritten.
- Finder file sharing and **Files → On My iPhone → SPlayer → Videos** expose the
  same folder tree. Pull to refresh after external changes. Moving or renaming
  inside SPlayer updates playlist references; external moves/renames show missing
  entries, which can be removed and added again.
- Supported containers: MP4, M4V, MOV, with codecs supported by the device's AVKit
  player (typically H.264 or HEVC). MKV/AVI and desktop FFmpeg codecs are not part
  of this native version. Unsupported imports and playback failures are reported.

## Playlists

Create named playlists in the Playlists tab. Add videos from any folder, use Edit
to reorder or remove entries, and tap Play All for automatic sequential playback.
The player provides native scrubbing, audio/subtitle selection when embedded,
and previous/next controls. Closing the player stops playback. Playlist edits
are saved atomically and survive application restarts. Deleting a playlist does
not delete its videos.

## Build, test, and install

Requires Xcode with an iOS SDK. The Xcode project is checked in; XcodeGen is needed
only after editing `project.yml` (`cd ios && xcodegen generate`). The build scripts
take the version from the repository's `package.json`.

```sh
SPLAYER_IOS_SIMULATOR='<simulator UUID>' npm run test:ios
SPLAYER_IOS_TEAM='<Apple team ID>' npm run build:ios
SPLAYER_IOS_TEAM='<Apple team ID>' SPLAYER_IOS_DEVICE='<paired iPhone UUID>' npm run install:ios
```

The device must be paired, reachable, and have Developer Mode enabled; Xcode must
have an Apple account able to provision the app. No signing credentials or
personal device identifiers are stored in the project. The signed build is at
`build/ios/Build/Products/Release-iphoneos/SPlayer.app`. Development installations
remain usable only while their provisioning profile is valid.

Tests cover recursive imports, duplicate names, playlist persistence/order,
folder move/delete references, failed-write rollback, corrupt metadata, path
traversal, symlinks, recursive self-import, and folder/playlist UI persistence.
