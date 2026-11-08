#!/bin/sh
# Compile SpeechProbe.swift into $1 (default /tmp/speech-probe/SpeechProbe).
set -eu
OUT="${1:-/tmp/speech-probe/SpeechProbe}"
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$(dirname "$OUT")"
swiftc -parse-as-library -O -target arm64-apple-macos26 -o "$OUT" "$HERE/SpeechProbe.swift"
echo "built $OUT"
