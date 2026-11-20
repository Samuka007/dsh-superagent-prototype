# secrets/

Deployment credentials for dsh-superagent. Two kinds of files live here:

| File | Committed? | What it is |
| --- | --- | --- |
| `deployment.enc.yaml` | yes | The single sops-managed file: patch structure + `gh_agent_pat` / `newapi_api_key` / `deepseek_api_key`, with secret values encrypted inline (`ENC[...]`); non-secret config stays readable. Decrypt key lives on the parent host (`dragonos-lab:~/dsh-deploy/keys.txt`) and nowhere else. |
| `staging.env` | **never** (git-ignored) | Legacy plaintext staging from the first-run wizard; superseded by editing the sops file directly (`sops secrets/deployment.enc.yaml`). Delete freely. |

Provisioning flow (one encrypted file, one script):

```
secrets/deployment.enc.yaml   ← the ONLY secret artifact (sops yaml: secret values are
                                ENC[...] inline; patch structure stays readable)
deploy/apply-secrets.sh       ← decrypts and delivers: patch -> profile dir,
                                newapi key -> ~/.dsh-env, PAT -> gh-agent keyring,
                                then restarts the service
```

Rotate: edit the values with `sops secrets/deployment.enc.yaml` (decrypts in-editor,
re-encrypts on save), commit, run `deploy/apply-secrets.sh superagent@10.0.100.3`.
`deploy/wizard-secrets.sh` is the first-run bootstrap that seeds the file.

Adapter caveat (empirically verified): `dsh-llm-pi-ai` providers honor only
`apiKeyEnv` (so the newapi key is delivered as env); `web-search-deepseek` accepts a
literal `apiKey`, which is why it can live inside the patch itself.
