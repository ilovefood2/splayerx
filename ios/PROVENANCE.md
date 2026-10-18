# Source and licensing boundary

xplayer is a standalone native iPhone/iPad application. Its application code,
tests, build configuration, and new artwork are offered under the MIT license
in this directory. The project owner authorized this independent release on
2026-10-18. This grant does not relicense any upstream SPlayer work.

## Development record

The initial five Swift source files were written for a native SwiftUI/AVKit
application in commit `7aec85288625af418fa799a79c8ba57229a881d0` of
https://github.com/ilovefood2/splayerx. The implementation uses Apple APIs for
file picking, local file storage, SwiftUI views, and AVKit playback. It does not
compile, link, translate, or call the upstream Electron/Vue desktop player,
FFmpeg, VLC, or SPlayer subtitle libraries.

Filesystem fixes are recorded in `afd66ae2a` and `6560983d3` in that repository.
The source snapshot before the xplayer release preparation is `6560983d3`.
These public commits preserve the development history without importing the
desktop repository or historical artwork into this standalone project.

The first development build temporarily copied the upstream SPlayer icon. It
was replaced before this extraction. The current icon was generated without a
reference image; see AppIcon.md for the prompt and provenance. The upstream
icon is not included in xplayer's source tree or application bundle. The test
video is a synthetic FFmpeg test pattern, not a third-party film or recording,
and is included in the test bundle only.

## What is not relicensed

The original https://github.com/chiflix/splayerx project and its desktop fork
remain governed by their existing GPL-3.0-or-later license and notices. Their
brand, logos, implementations, and third-party dependencies are not licensed
to others by this project's MIT grant. Earlier GPL grants, where applicable,
are not revoked by the separate MIT grant for independently created material.

The same feature idea, a new programming language, or moving a file alone does
not establish independence. Do not import upstream implementations or artwork
without reviewing the actual license and distribution requirements. New
contributions must be original or accompanied by compatible permissions and
attribution. Record any new dependency in THIRD_PARTY_NOTICES.md.

## Remaining external checks

The name xplayer is user-selected. Similar names exist in public app listings;
this document does not establish trademark clearance or App Store name
availability. Apple review and any professional legal opinion remain separate
from the source/build checks in this project.
