#!/usr/bin/env bash
set -euo pipefail
XPLAYER_MODULE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../ios" && pwd)"
export XPLAYER_TEAM_ID="${XPLAYER_TEAM_ID:-${SPLAYER_IOS_TEAM:-}}"
export XPLAYER_DEVICE_ID="${XPLAYER_DEVICE_ID:-${SPLAYER_IOS_DEVICE:-}}"
export XPLAYER_SIMULATOR_ID="${XPLAYER_SIMULATOR_ID:-${SPLAYER_IOS_SIMULATOR:-}}"
exec "${XPLAYER_MODULE}/scripts/build.sh" "${1:-build}"
