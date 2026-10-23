#!/usr/bin/env bash
# Builds the default cover of the MP3s (1400 × 1400 px, as podcast directories ask for) from the eAg logo:
# the logo centred on white. Needs rsvg-convert and ImageMagick. Run again after changing the logo.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/../apps/predigt-schnitt/src/cover" && pwd)"
TMP=$(mktemp --suffix=.png)
trap 'rm -f "$TMP"' EXIT
rsvg-convert -h 1040 "$DIR/eag-logo.svg" -o "$TMP"
magick -size 1400x1400 xc:white "$TMP" -gravity center -geometry +0+0 -composite \
  -strip -sampling-factor 4:2:0 -quality 86 "$DIR/eag-cover.jpg"
echo "$DIR/eag-cover.jpg: $(du -k "$DIR/eag-cover.jpg" | cut -f1) kB"
