#!/usr/bin/env bash
# The one provisioning script: decrypt the single sops file and deliver everything.
#
#   apply-secrets.sh <user@container-ip> [enc-file]
#
# Runs on any machine that can ssh BOTH the sops host (which holds the age key)
# and the target container. jq must be installed here.
#   SOPS_HOST  where ~/dsh-deploy/bin/sops + keys.txt live (default dragonos@100.64.0.4)
# Delivery:
#   .patch          -> ~/.dsh/profiles/superagent/cordis.patch.yml
#   newapi_api_key  -> ~/.dsh-env (env; pi-ai only honors apiKeyEnv)
#   gh_agent_pat    -> gh-agent keyring
# Then restarts the service. Secrets transit only through pipes, never at rest
# outside the container's own credential stores.
set -euo pipefail

DEST=${1:?usage: apply-secrets.sh <user@container-ip> [enc-file]}
HERE=$(cd "$(dirname "$0")" && pwd)
ENC=${2:-$HERE/../secrets/deployment.enc.yaml}
SOPS_HOST=${SOPS_HOST:-dragonos@100.64.0.4}
SOPS_CMD=${SOPS_CMD:-'~/dsh-deploy/bin/sops'}

command -v jq >/dev/null || { echo "jq required on the runner machine" >&2; exit 64; }

# 1. land the encrypted file on the sops host and decrypt to memory.
scp -q -o BatchMode=yes "$ENC" "$SOPS_HOST:/tmp/apply.enc.yaml"
REMOTE_KEY=${SOPS_AGE_KEY_REMOTE:-'~/dsh-deploy/keys.txt'}
PLAIN=$(ssh -o BatchMode=yes "$SOPS_HOST" "SOPS_AGE_KEY_FILE=$REMOTE_KEY $SOPS_CMD -d --input-type yaml --output-type json /tmp/apply.enc.yaml; rm -f /tmp/apply.enc.yaml")
[[ -n "$PLAIN" ]] || { echo "decryption produced nothing" >&2; exit 2; }

# 2. patch -> profile dir
printf '%s' "$PLAIN" | jq -c '.patch' | ssh -o BatchMode=yes "$DEST" \
  'cat > ~/.rendered.patch.yml && mkdir -p ~/.dsh/profiles/superagent && mv ~/.rendered.patch.yml ~/.dsh/profiles/superagent/cordis.patch.yml && chmod 600 ~/.dsh/profiles/superagent/cordis.patch.yml && echo patch-delivered'

# 3. model key -> env file (pi-ai honors only apiKeyEnv)
NEWAPI=$(printf '%s' "$PLAIN" | jq -r '.newapi_api_key')
printf 'export NEWAPI_API_KEY=%q\n' "$NEWAPI" | ssh -o BatchMode=yes "$DEST" \
  'cat > ~/.dsh-env && chmod 600 ~/.dsh-env && { grep -q dsh-env ~/.bashrc 2>/dev/null || { printf "set -a; . ~/.dsh-env; set +a\n" | cat - ~/.bashrc > /tmp/b && mv /tmp/b ~/.bashrc && chmod 600 ~/.bashrc; }; } && echo env-delivered'

# 4. PAT -> gh-agent keyring
printf '%s' "$PLAIN" | jq -r '.gh_agent_pat' | ssh -o BatchMode=yes "$DEST" \
  'GH_CONFIG_DIR="$HOME/.config/gh-agent" gh auth login --with-token >/dev/null 2>&1 && GH_CONFIG_DIR="$HOME/.config/gh-agent" gh api user --jq .login && echo keyring-delivered'

# 5. restart (config + env are read at boot; env rotation needs a fresh server)
ssh -o BatchMode=yes "$DEST" \
  'tmux kill-server 2>/dev/null; sleep 1; cd ~/dsh-superagent && scripts/dsh-superagent start >/dev/null 2>&1; scripts/dsh-superagent status >/dev/null 2>&1; echo "status exit=$?"'
