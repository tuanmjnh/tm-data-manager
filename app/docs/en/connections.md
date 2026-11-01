---
title: Connecting to data
description: Add, test and manage connections for SQLite, PostgreSQL, MySQL and MongoDB
section: data
order: 2
updated: 2026-11-01
tags: connection, sqlite, postgresql, mysql, mongodb
---

# Connecting to data

Every data source is a **connection**: a provider id, a config object and — when needed — an encrypted
credential.

## Supported providers

| Provider | Read | Write | Schema | Notes |
|---|---|---|---|---|
| `sqlite` | ✓ | ✓ | ✓ | A `.db` file, via `node:sqlite` |
| `postgresql` | ✓ | ✓ | ✓ | Streaming through `pg-cursor`; profiles `supabase`, `neon` |
| `mysql` | ✓ | ✓ | ✓ | MySQL & MariaDB; profile `planetscale` |
| `mongodb` | ✓ | ✓ | sampled | Atlas or self-hosted; schema inferred from sample documents |

Capabilities are declared by the provider and enforced by the engine. The UI only offers actions the
provider can actually perform, so you never get a button that fails after the click.

## Adding a connection

**In the UI:** **Connections → Add connection**, pick a provider, then fill the form generated from the
provider's `config_fields`.

**From the CLI:**

```bash
udmt connection add --name local-src --provider sqlite --path ./data/fixtures/source.db
udmt connection add --name staging-pg --provider postgresql \
  --host db.example.com --database app --user app --password-stdin
```

Passwords can come in through `--password-stdin` or be embedded in a URI; UDMT strips the password out
of the config and encrypts it with AES-256-GCM in the vault before storing.

### Defaults for a local machine

The form is pre-filled with values that work on this machine, so **Create connection** is enough:

| Provider | Default |
|---|---|
| `sqlite` | none — point at your own `.db` file |
| `postgresql` | `localhost:5432`, database `postgres`, user `postgres`, TLS `disable` |
| `mysql` | `localhost:3306`, user `root`, TLS `disable` |
| `mongodb` | `mongodb://localhost:27017` |

Switching **Environment** away from `local` turns TLS back to `require` unless you changed it yourself,
and you still need to point host/user at the real server. Passwords are never pre-filled — type them in
the Password field so they go into the vault.

## Testing and discovery

```bash
udmt connection test local-src        # connect + quick_check
udmt connection discover local-src    # list tables/views
udmt connection schema local-src users
```

In the UI, **Test**, **Discover** and **Schema** sit on each row of the connection table.

## Editing and common mistakes

- Rename, re-target, change the password or enable/disable a connection with the pencil button, or
  `udmt connection update <name> --path ...`.
- SQLite paths are resolved **once**, when the connection is saved. If the file moves, run
  `udmt connection update <name> --path <new-path>`.
- Marking a connection `production` makes destructive writes require typing the connection name.

> Credentials are never echoed back in logs or the UI. An empty password field while editing means
> “keep the existing password”.
