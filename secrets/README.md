# secrets/

Deployment credentials for dsh-superagent. Two kinds of files live here:

| File | Committed? | What it is |
| --- | --- | --- |
| `staging.env` | **never** (git-ignored) | Plaintext staging written by `deploy/wizard-secrets.sh`. Provisioned into the container, then safe to delete; re-run the wizard to restore. |
| `*.enc.env` | yes | SOPS age-encrypted archives of the same values (dotenv format), for re-provisioning a rebuilt container. Decrypt key lives on the parent host (`dragonos-lab:~/dsh-deploy/keys.txt`) and nowhere else. Decrypt with `sops --input-type dotenv --output-type dotenv -d`. |

Provisioning flow: wizard → `staging.env` → sops-encrypt to `*.enc.env` (commit) → three delivery paths:
1. **Rendered config literals** — `deploy/render-patch.sh` decrypts, substitutes into `deploy/cordis.patch.template.yml`, pushes to the container, restarts. Used by adapters that accept a literal `apiKey` (verified: `web-search-deepseek`).
2. **Env file** — adapters that only honor `apiKeyEnv` (verified: `dsh-llm-pi-ai` providers ignore literal keys) get `~/.dsh-env` written from the same archive, sourced via `.bashrc`; changing these values requires `tmux kill-server` before restart.
3. **gh keyring** — `gh-agent auth login --with-token` for the agent PAT.

Rotate: edit `staging.env` via the wizard, re-encrypt, re-run the matching delivery path.
