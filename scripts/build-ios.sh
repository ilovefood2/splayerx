#!/usr/bin/env bash
set -euo pipefail

SPLAYER_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPLAYER_VERSION="$(node -p "require(process.argv[1]).version" "${SPLAYER_ROOT}/package.json")"
SPLAYER_BUILD="${SPLAYER_ROOT}/build/ios"
SPLAYER_MODE="${1:-build}"
SPLAYER_PROJECT="${SPLAYER_ROOT}/ios/SPlayer.xcodeproj"
SPLAYER_OPTIONS=(
  -project "${SPLAYER_PROJECT}" -scheme SPlayer
  -derivedDataPath "${SPLAYER_BUILD}"
  "MARKETING_VERSION=${SPLAYER_VERSION}"
  "CURRENT_PROJECT_VERSION=${SPLAYER_VERSION##*.}"
)

case "${SPLAYER_MODE}" in
  test)
    : "${SPLAYER_IOS_SIMULATOR:?Set SPLAYER_IOS_SIMULATOR to an available iOS simulator UUID.}"
    xcodebuild "${SPLAYER_OPTIONS[@]}" -destination "platform=iOS Simulator,id=${SPLAYER_IOS_SIMULATOR}" \
      -parallel-testing-enabled NO -collect-test-diagnostics never CODE_SIGNING_ALLOWED=NO test
    ;;
  build|install)
    : "${SPLAYER_IOS_TEAM:?Set SPLAYER_IOS_TEAM to your Apple development team ID.}"
    SPLAYER_DESTINATION='generic/platform=iOS'
    if [[ "${SPLAYER_MODE}" == install ]]; then
      : "${SPLAYER_IOS_DEVICE:?Set SPLAYER_IOS_DEVICE to the paired iPhone UDID.}"
      SPLAYER_DESTINATION="platform=iOS,id=${SPLAYER_IOS_DEVICE}"
    fi
    xcodebuild "${SPLAYER_OPTIONS[@]}" -configuration Release -destination "${SPLAYER_DESTINATION}" \
      -allowProvisioningUpdates -allowProvisioningDeviceRegistration "DEVELOPMENT_TEAM=${SPLAYER_IOS_TEAM}" clean build
    SPLAYER_APP="${SPLAYER_BUILD}/Build/Products/Release-iphoneos/SPlayer.app"
    codesign --verify --deep --strict "${SPLAYER_APP}"
    if [[ "${SPLAYER_MODE}" == install ]]; then
      xcrun devicectl device install app --device "${SPLAYER_IOS_DEVICE}" "${SPLAYER_APP}"
      xcrun devicectl device process launch --device "${SPLAYER_IOS_DEVICE}" org.splayer.ios
    fi
    echo "iOS application: ${SPLAYER_APP} (${SPLAYER_VERSION})"
    ;;
  *) echo 'Usage: scripts/build-ios.sh [build|test|install]' >&2; exit 2 ;;
esac
