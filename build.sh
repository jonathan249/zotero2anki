#!/bin/sh
# Package src/ into build/zotero2anki-<version>.xpi
set -e
cd "$(dirname "$0")"

version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' src/manifest.json | head -n 1)
out="build/zotero2anki-${version}.xpi"

mkdir -p build
rm -f "$out"
(cd src && zip -q -r -X "../$out" . -x '.*' -x '*/.*')
echo "Built $out"
