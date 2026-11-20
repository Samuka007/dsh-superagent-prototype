# secrets/

Deployment credentials for dsh-superagent: three sops-encrypted files, one per
destination. Decrypt key lives on the parent host (`dragonos-lab:~/dsh-deploy/keys.txt`)
and nowhere else.

| File | Decrypts to | Consumer |
| --- | --- | --- |
| `cordis.patch.enc.yml` | `~/.dsh/profiles/superagent/cordis.patch.yml` | DSH profile patch (patch structure readable; `apiKey` values ENC inline) |
| `dsh-env.enc` | `~/.dsh-env` (dotenv) | model key, sourced via `.bashrc` (`set -a`; pi-ai honors only `apiKeyEnv`) |
| `gh.pat.enc` | raw token stream | `gh-agent` keyring (`gh auth login --with-token`) |

## Apply

```
./deploy/apply-secrets.sh superagent@10.0.100.3
```

Decrypts each file on the sops host and delivers to its destination, then restarts
the service and reports `status` exit code. Runs on any machine that can ssh both
the sops host and the target.

## Rotate

Edit values with `sops secrets/cordis.patch.enc.yml` (decrypts in-editor,
re-encrypts on save) — or rebuild the plaintext source and re-encrypt:

```sh
printf 'NEWAPI_API_KEY=%s\n' "$NEWAPI" > dsh-env.plain
sops --input-type dotenv --age <age-pub> -e dsh-env.plain > dsh-env.enc
```

then commit and apply. Values arrive from your own secret sources; nothing here is
entered through chat.

## Rebuild container (full re-provisioning)

1. clone + `pnpm build` the bundle, create the DSH profile and plugin (`docs/006-deployment.md`)
2. `deploy/apply-secrets.sh` — credentials (above)
3. settings (Sources / Policy / Execution) live in the state SQLite
   (`~/.dsh-state/orchestrator.sqlite`) — restore your state backup, or enter them
   once via the panel / management API (`docs/006-deployment.md` "Management API"
   has the PUT example). They persist and survive restarts; they are deliberately
   NOT in this repository.
4. `scripts/dsh-superagent start`
