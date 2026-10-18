# xplayer

An offline video library for iPhone and iPad, with nested folders and saved
playlists. Requires iOS 17 or later. Native SwiftUI / AVKit, with no third-party
runtime dependencies, ads, accounts, or analytics.

- Import MP4, M4V, and MOV videos or entire folder trees through Files.
- Create, move, rename, and delete folders; combine videos into playlists.
- Reorder playlists and play them in sequence using native playback controls.
- Read privacy, support, and license documents offline in About.

The device's Apple codec support applies. MKV/AVI, DRM-protected files, website
downloads, and desktop FFmpeg codecs are not included.

## Source and license

The native application is independently implemented and MIT-licensed. See
[LICENSE](LICENSE), [PROVENANCE.md](PROVENANCE.md),
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), and [AppIcon.md](AppIcon.md).
The upstream SPlayer desktop project retains its original GPL license. This
application is not an official SPlayer release.

## Build and test

Requires Xcode, an iOS SDK, Python 3, and an installed simulator runtime.
The checked-in Xcode project builds directly. XcodeGen is only needed after
editing `project.yml` (`xcodegen generate`). No Node dependencies are installed;
`package.json` holds the version and optional npm command aliases.

```sh
python3 scripts/verify-release.py
XPLAYER_SIMULATOR_ID='<simulator UUID>' scripts/build.sh test
scripts/build.sh build  # unsigned device build when no team is supplied
XPLAYER_TEAM_ID='<team ID>' XPLAYER_DEVICE_ID='<iPhone UDID>' scripts/build.sh install
XPLAYER_TEAM_ID='<enrolled team ID>' scripts/build.sh archive
XPLAYER_TEAM_ID='<enrolled team ID>' scripts/build.sh export
```

Build output goes into `build/`. Set `XPLAYER_BUILD_DIR` to isolate concurrent
simulator/device builds. App Store export needs a paid developer membership,
distribution signing, and a correctly configured App Store Connect record.
The export command only creates a local IPA; it does not upload or submit it.

## Privacy and support website

The app's bundled Markdown documents are the source of the public website:

```sh
python3 scripts/build-site.py
python3 scripts/verify-release.py --check-urls
```

Serve `docs/` with GitHub Pages. The intended URLs are:

- https://ilovefood2.github.io/xplayer/privacy.html
- https://ilovefood2.github.io/xplayer/support.html

These URLs must be live and checked before submission. Store metadata, review
notes, and remaining account-dependent steps are in `metadata/`.

## Moving from the development SPlayer build

The new bundle ID is `com.ilovefood2.xplayer`; iOS gives it a separate container.
Keep the old application until its files have been copied and verified. The
local migration helper in `scripts/migrate-device-library.py` copies the old
Documents and Application Support directories through an ignored local backup,
requires an empty destination, and never deletes the old app or its files.

Personal media and migration backups must never be committed or published.
