# secrets/

Deployment credentials for dsh-superagent. Two kinds of files live here:

| File | Committed? | What it is |
| --- | --- | --- |
| `staging.env` | **never** (git-ignored) | Plaintext staging written by `deploy/wizard-secrets.sh`. Provisioned into the container, then safe to delete; re-run the wizard to restore. |
| `*.enc.yaml` | yes | SOPS age-encrypted archives of the same values, for re-provisioning a rebuilt container. Decrypt key lives on the parent host (`dragonos-lab:~/dsh-deploy/keys.txt`) and nowhere else. |

Provisioning flow: wizard → `staging.env` → sops-encrypt to `*.enc.yaml` (commit) → decrypt and pipe into the container's credential stores (DSH profile env, `gh-agent` keyring). No plaintext at rest inside the container beyond the credential stores themselves.

Rotate: edit `staging.env` via the wizard, re-encrypt, redeploy.
