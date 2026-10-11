#!/bin/sh
# Build Gesso into dist/ (static PWA). Usage: ./build.sh [--dev]
set -e
cd "$(dirname "$0")"
V=$(date +%Y%m%d%H%M%S)
rm -rf dist && mkdir -p dist
cp -r public/* dist/
npx esbuild src/main.ts --bundle --format=iife --target=chrome100 --minify --sourcemap --outfile=dist/app.js --log-level=warning
sed -i "s/__V__/$V/g" dist/index.html dist/sw.js
echo "built dist ($V)"
