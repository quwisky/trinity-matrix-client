#!/bin/sh
set -eu

source_file="${SRCROOT}/App/GoogleService-Info.plist"
destination="${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}/GoogleService-Info.plist"

if [ -s "${source_file}" ]; then
  mkdir -p "$(dirname "${destination}")"
  cp "${source_file}" "${destination}"
else
  rm -f "${destination}"
fi
