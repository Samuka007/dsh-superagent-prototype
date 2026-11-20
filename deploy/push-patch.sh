#!/usr/bin/env bash
# Stage 2 — push (pure remote operation, no sops/age involvement).
# Run this wherever ssh access to the target exists; the target only needs the
# service checkout at SERVICE_DIR.
#
# Usage:
#   push-patch.sh <user@target> <rendered.patch.yml> [profile-dir] [service-dir]
# Defaults: profile-dir ~/.dsh/profiles/superagent; service-dir ~/dsh-superagent.
set -euo pipefail

DEST=${1:?usage: push-patch.sh <user@target> <rendered.patch.yml> [profile-dir] [service-dir]}
FILE=${2:?missing rendered patch}
DIR=${3:-.dsh/profiles/superagent}
SVC=${4:-dsh-superagent}

scp -q -o BatchMode=yes "$FILE" "$DEST:.rendered.patch.yml"
ssh -o BatchMode=yes "$DEST" "
  set -e
  mkdir -p ~/\"\$DIR\" 2>/dev/null || true
  mv ~/.rendered.patch.yml ~/\"\$DIR\"/cordis.patch.yml
  chmod 600 ~/\"\$DIR\"/cordis.patch.yml
  cd ~/\"\$SVC\"
  scripts/dsh-superagent restart --timeout 120 >/dev/null 2>&1
  scripts/dsh-superagent status >/dev/null 2>&1
  echo 'status exit=' \$?
"
