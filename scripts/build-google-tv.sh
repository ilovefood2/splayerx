#!/usr/bin/env bash

set -euo pipefail

SPLAYER_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPLAYER_TV_VERSION="$(node -p "require('${SPLAYER_REPO_ROOT}/package.json').version")"
SPLAYER_TV_APK_SOURCE="${SPLAYER_REPO_ROOT}/google-tv/app/build/outputs/apk/debug/app-debug.apk"
SPLAYER_TV_APK_DESTINATION="${SPLAYER_REPO_ROOT}/build/SPlayer-GoogleTV-${SPLAYER_TV_VERSION}.apk"

"${SPLAYER_REPO_ROOT}/google-tv/gradlew" \
  -p "${SPLAYER_REPO_ROOT}/google-tv" \
  --no-daemon \
  clean test lintDebug assembleDebug

cp "${SPLAYER_TV_APK_SOURCE}" "${SPLAYER_TV_APK_DESTINATION}"
shasum -a 256 "${SPLAYER_TV_APK_DESTINATION}" \
  > "${SPLAYER_TV_APK_DESTINATION}.sha256"

echo "Google TV APK: ${SPLAYER_TV_APK_DESTINATION}"
