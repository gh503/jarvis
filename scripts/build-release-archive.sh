#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

REF="${2:-HEAD}"
COMMIT="$(git rev-parse "$REF^{commit}")"
VERSION="$(git show "$REF:package.json" | node -e 'let input=""; process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => process.stdout.write(JSON.parse(input).version))')"
OUTPUT="${1:-$ROOT/release/jarvis-mac-mvp-v$VERSION.zip}"
CHECKSUM="$OUTPUT.sha256"
PREFIX="jarvis-mac-mvp-v$VERSION/"
TEMPORARY="$OUTPUT.tmp.$$"

mkdir -p "$(dirname "$OUTPUT")"
trap 'rm -f "$TEMPORARY"' EXIT
git archive --format=zip --prefix="$PREFIX" -o "$TEMPORARY" "$REF"
unzip -t "$TEMPORARY" >/dev/null

while IFS= read -r entry; do
  case "$entry" in
    */.env|*/.dsh/*|*/.jarvis-runtime/*|*/backups/*|*/data/*|*/node_modules/*|*/dist/*|*/.git/*|*.pem|*.key|*.p12|*.pfx)
      print -u2 "release archive contains forbidden path: $entry"
      exit 1
      ;;
  esac
done < <(unzip -Z1 "$TEMPORARY")

if [[ "$(unzip -z "$TEMPORARY" | tail -n 1)" != "$COMMIT" ]]; then
  print -u2 'release archive commit marker does not match the requested ref.'
  exit 1
fi

mv -f "$TEMPORARY" "$OUTPUT"
chmod 644 "$OUTPUT"
(
  cd "$(dirname "$OUTPUT")"
  shasum -a 256 "$(basename "$OUTPUT")" > "$(basename "$CHECKSUM")"
)
chmod 644 "$CHECKSUM"
echo "Release archive: $OUTPUT"
cat "$CHECKSUM"
