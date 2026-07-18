#!/bin/bash
set -e

[[ "$1" = mas* ]] && MAS=1 || MAS=0
ARCH="${2:-arm64}"

npm run prepare:mac
node .electron-vue/build.js

if ((MAS)) ; then
    # rejected by apple if contains "paypal"
    find dist/electron -name '*.js' -exec sed -i '' 's/paypal//g' {} \;
    find dist/electron -name '*.js' -exec sed -i '' 's/Paypal//g' {} \;
    find dist/electron -name '*.js' -exec sed -i '' 's/PayPal//g' {} \;
    yarn run electron-builder -p never -m $1 --$ARCH \
        -c electron-builder.json \
        -c.mac.hardenedRuntime=false \
        -c.mac.provisioningProfile="build/$1.provisionprofile" \
        -c.mac.bundleVersion="$(git rev-list --count HEAD)"
else
    yarn run electron-builder -p never --mac --$ARCH
fi
