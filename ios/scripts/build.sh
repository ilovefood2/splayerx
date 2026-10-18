#!/usr/bin/env bash
set -euo pipefail

XPLAYER_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
XPLAYER_VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "${XPLAYER_ROOT}/package.json")"
XPLAYER_BUILD="${XPLAYER_BUILD_DIR:-${XPLAYER_ROOT}/build}"
XPLAYER_MODE="${1:-build}"
XPLAYER_OPTIONS=(
  -project "${XPLAYER_ROOT}/XPlayer.xcodeproj" -scheme XPlayer
  -derivedDataPath "${XPLAYER_BUILD}"
  "MARKETING_VERSION=${XPLAYER_VERSION}" "CURRENT_PROJECT_VERSION=${XPLAYER_VERSION##*.}"
)
XPLAYER_SIGNING=(CODE_SIGNING_ALLOWED=NO)
if [[ -n "${XPLAYER_TEAM_ID:-}" ]]; then
  XPLAYER_SIGNING=(-allowProvisioningUpdates -allowProvisioningDeviceRegistration "DEVELOPMENT_TEAM=${XPLAYER_TEAM_ID}")
fi
python3 "${XPLAYER_ROOT}/scripts/verify-release.py"

case "${XPLAYER_MODE}" in
  test)
    : "${XPLAYER_SIMULATOR_ID:?Set XPLAYER_SIMULATOR_ID to an available iOS simulator UUID.}"
    xcodebuild "${XPLAYER_OPTIONS[@]}" -destination "platform=iOS Simulator,id=${XPLAYER_SIMULATOR_ID}" \
      -parallel-testing-enabled NO -collect-test-diagnostics never CODE_SIGNING_ALLOWED=NO test
    ;;
  build|install)
    XPLAYER_DESTINATION='generic/platform=iOS'
    if [[ "${XPLAYER_MODE}" == install ]]; then
      : "${XPLAYER_TEAM_ID:?Set XPLAYER_TEAM_ID to your Apple team ID.}"
      : "${XPLAYER_DEVICE_ID:?Set XPLAYER_DEVICE_ID to the paired iPhone UDID.}"
      XPLAYER_DESTINATION="platform=iOS,id=${XPLAYER_DEVICE_ID}"
    fi
    xcodebuild "${XPLAYER_OPTIONS[@]}" -configuration Release -destination "${XPLAYER_DESTINATION}" \
      "${XPLAYER_SIGNING[@]}" clean build
    XPLAYER_APP="${XPLAYER_BUILD}/Build/Products/Release-iphoneos/XPlayer.app"
    python3 "${XPLAYER_ROOT}/scripts/verify-release.py" --app "${XPLAYER_APP}"
    if [[ "${XPLAYER_MODE}" == install ]]; then
      codesign --verify --deep --strict "${XPLAYER_APP}"
      xcrun devicectl device install app --device "${XPLAYER_DEVICE_ID}" "${XPLAYER_APP}"
      xcrun devicectl device process launch --terminate-existing --device "${XPLAYER_DEVICE_ID}" com.ilovefood2.xplayer
    fi
    echo "Built xplayer ${XPLAYER_VERSION}: ${XPLAYER_APP}"
    ;;
  archive)
    xcodebuild "${XPLAYER_OPTIONS[@]}" -configuration Release -destination 'generic/platform=iOS' \
      -archivePath "${XPLAYER_BUILD}/xplayer-${XPLAYER_VERSION}.xcarchive" \
      "${XPLAYER_SIGNING[@]}" clean archive
    python3 "${XPLAYER_ROOT}/scripts/verify-release.py" \
      --app "${XPLAYER_BUILD}/xplayer-${XPLAYER_VERSION}.xcarchive/Products/Applications/XPlayer.app"
    ;;
  export)
    : "${XPLAYER_TEAM_ID:?App Store export requires an enrolled Apple Developer team.}"
    xcodebuild -exportArchive -archivePath "${XPLAYER_BUILD}/xplayer-${XPLAYER_VERSION}.xcarchive" \
      -exportPath "${XPLAYER_BUILD}/app-store" -exportOptionsPlist "${XPLAYER_ROOT}/metadata/ExportOptions.plist" \
      -allowProvisioningUpdates "DEVELOPMENT_TEAM=${XPLAYER_TEAM_ID}"
    ;;
  *) echo 'Usage: scripts/build.sh [build|test|install|archive|export]' >&2; exit 2 ;;
esac
