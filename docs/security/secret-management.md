# Secret management

## Storage

- A connection has non-secret `config_json` and a `credential_ref` (`localvault:<id>`).
- Secrets are AES-256-GCM encrypted as `{v, iv, tag, data}` in the `secrets` table.
- The 32-byte master key lives in `<data-dir>/secrets.key` with mode `0600`.

## Known limitation (must be shown in the UI)

The master key file is protected by the operating system account, **not** by an OS keyring. This is the
documented fallback allowed by the roadmap ("explicitly report the limitation"). `udmt doctor` and the
System page print:

> Master key is stored in a 0600 file in the app data directory, not an OS keyring.

A keyring backend (Windows Credential Manager / macOS Keychain / libsecret) is planned; the
`SecretStore` class is the only place that would change.

## Rules enforced in code

- No plaintext secret ever reaches SQLite (a test greps the DB file for a known password).
- The API never returns secret material; `ConnectionRecord` only exposes `credential_ref` presence.
- Full connection strings are accepted at the boundary and the password is extracted into the vault
  (`normalizeInlineSecret`), so `config_json` never contains a password.
- `sanitizeErrorMessage` / `maskEndpoint` redact URIs, `password=`/`token=` parameters and bearer tokens
  before logs, run errors or endpoint hints are stored.
- Run config is sanitized when displayed (keys matching password/secret/token/uri/url are masked).
- Deleting a connection deletes its secret record.
- `--password` is supported but the CLI recommends `--password-stdin` to keep it out of shell history.

## Not implemented

OS keyring, encrypted export/import bundles of connection profiles, per-operation credential scoping for
plugins (Phase 7), and secret rotation workflow. None of these are simulated.
