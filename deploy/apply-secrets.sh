#!/usr/bin/env bash
# Three secret files, three destinations. Each delivery is: decrypt on the sops
# host -> pipe -> place on the target. No routing, no multiplexing.
#
#   secrets/cordis.patch.enc.yml -> ~/.dsh/profiles/superagent/cordis.patch.yml
#   secrets/dsh-env.enc          -> ~/.dsh-env  (dotenv; sourced via .bashrc)
#   secrets/gh.pat.enc           -> gh-agent keyring (raw token stream)
#
# Usage: apply-secrets.sh <user@container-ip> [secrets-dir]
# Runs on any machine that can ssh both the sops host (age key holder) and the
# target. The sops host must also be able to ssh the target for the final restart.
set -euo pipefail

DEST=${1:?usage: apply-secrets.sh <user@container-ip> [secrets-dir]}
DIR=${2:-$(cd "$(dirname "$0")" && pwd)/../secrets}
SOPS_HOST=${SOPS_HOST:-dragonos@100.64.0.4}
SOPS_CMD=${SOPS_CMD:-'~/dsh-deploy/bin/sops'}
RKEY=${SOPS_AGE_KEY_REMOTE:-'~/dsh-deploy/keys.txt'}

STAGE=$(ssh -o BatchMode=yes "$SOPS_HOST" 'mktemp -d /tmp/apply.XXXXXX')
trap 'ssh -o BatchMode=yes "$SOPS_HOST" "rm -rf $STAGE"' EXIT

for f in cordis.patch.enc.yml dsh-env.enc gh.pat.enc; do
  scp -q -o BatchMode=yes "$DIR/$f" "$SOPS_HOST:$STAGE/$f"
done

# Each delivery: decrypt on the sops host -> shape -> place on the target.
# The patch enc file is a map-wrapped array (sops cannot encrypt top-level arrays);
# decrypt as JSON and extract .patch so the placed file is a top-level array again.
ssh -o BatchMode=yes "$SOPS_HOST" "SOPS_AGE_KEY_FILE=$RKEY $SOPS_CMD -d --output-type json '$STAGE/cordis.patch.enc.yml'" | jq -c '.patch' | ssh -o BatchMode=yes "$DEST" \
  'cat > ~/.rendered.patch.yml && mkdir -p ~/.dsh/profiles/superagent && mv ~/.rendered.patch.yml ~/.dsh/profiles/superagent/cordis.patch.yml && chmod 600 ~/.dsh/profiles/superagent/cordis.patch.yml && echo patch-placed'

ssh -o BatchMode=yes "$SOPS_HOST" "SOPS_AGE_KEY_FILE=$RKEY $SOPS_CMD -d --input-type json --output-type dotenv '$STAGE/dsh-env.enc'" | ssh -o BatchMode=yes "$DEST" \
  'cat > ~/.dsh-env && chmod 600 ~/.dsh-env && { grep -q dsh-env ~/.bashrc 2>/dev/null || { printf "set -a; . ~/.dsh-env; set +a\n" | cat - ~/.bashrc > /tmp/b && mv /tmp/b ~/.bashrc && chmod 600 ~/.bashrc; }; } && echo env-delivered'

ssh -o BatchMode=yes "$SOPS_HOST" "SOPS_AGE_KEY_FILE=$RKEY $SOPS_CMD -d --input-type json --output-type binary '$STAGE/gh.pat.enc'" | ssh -o BatchMode=yes "$DEST" \
  'GH_CONFIG_DIR="$HOME/.config/gh-agent" gh auth login --with-token >/dev/null && GH_CONFIG_DIR="$HOME/.config/gh-agent" gh api user --jq .login && echo keyring-delivered'

ssh -o BatchMode=yes "$DEST" \
  'tmux kill-server 2>/dev/null; sleep 1; cd ~/dsh-superagent && scripts/dsh-superagent start >/dev/null 2>&1; scripts/dsh-superagent status >/dev/null 2>&1; echo "status exit=$?"'
