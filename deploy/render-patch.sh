#!/usr/bin/env bash
# Stage 1 — render (pure local transform, no ssh, no machine assumptions).
# Inputs are all explicit paths; run this wherever the age private key lives.
#
# Usage:
#   render-patch.sh -t template.yml -a archive.enc.env \
#                   -k age.keys.txt [-s /path/to/sops] [-o rendered.patch.yml]
# Defaults: -k $SOPS_AGE_KEY_FILE or ~/.config/sops/age/keys.txt; -s sops on PATH;
#           output to stdout.
set -euo pipefail

SOPS=${SOPS:-sops}
AGEKEY=${SOPS_AGE_KEY_FILE:-$HOME/.config/sops/age/keys.txt}
OUT=/dev/stdout
TEMPLATE=""; ARCHIVE=""

while getopts "t:a:k:s:o:" opt; do
  case $opt in
    t) TEMPLATE=$OPTARG ;;
    a) ARCHIVE=$OPTARG ;;
    k) AGEKEY=$OPTARG ;;
    s) SOPS=$OPTARG ;;
    o) OUT=$OPTARG ;;
    *) echo "usage: render-patch.sh -t tpl -a archive.enc.env -k age.keys.txt [-s sops] [-o out]" >&2; exit 64 ;;
  esac
done
export SOPS_AGE_KEY_FILE=$AGEKEY
[[ -n "$TEMPLATE" && -n "$ARCHIVE" ]] || { echo "missing -t/-a" >&2; exit 64; }

umask 077
VALUES=$(mktemp)
trap 'rm -f "$VALUES"' EXIT
"$SOPS" --input-type dotenv --output-type dotenv -d "$ARCHIVE" > "$VALUES"

# Substitute ${KEY} placeholders from the decrypted dotenv. awk avoids sed-escaping
# pitfalls; an unmatched ${...} is left in place for the post-check to reject.
awk -v valsfile="$VALUES" '
  BEGIN { while ((getline line < valsfile) > 0) {
            if (line !~ /=/) continue
            k = line; sub(/=.*/, "", k)
            v = line; sub(/^[^=]*=/, "", v)
            gsub(/^['\'']/, "", v); gsub(/['\'']$/, "", v)
            V[k] = v
          } }
  { while (match($0, /\$\{[A-Za-z_][A-Za-z0-9_]*\}/)) {
      name = substr($0, RSTART + 2, RLENGTH - 3)
      if (!(name in V)) break
      $0 = substr($0, 1, RSTART - 1) V[name] substr($0, RSTART + RLENGTH)
    }
    print }
' "$TEMPLATE" > "$OUT"

if [[ "$OUT" != /dev/stdout ]] && grep -v '^[[:space:]]*#' "$OUT" | grep -q '\${'; then
  echo "ERROR: unresolved placeholders remain:" >&2
  grep -v '^[[:space:]]*#' "$OUT" | grep '\${' >&2
  exit 2
fi
