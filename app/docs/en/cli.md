---
title: CLI reference
description: Command groups, global flags, exit codes and JSON mode
section: reference
order: 10
updated: 2026-11-01
tags: cli, reference, json, exit-code
---

# CLI reference

Run it through `pnpm run udmt -- <command>` or directly as `node dist/cli/bin.js <command>`.

## Global flags

| Flag | Effect |
|---|---|
| `--json` | Print machine-readable JSON |
| `--quiet` | Hide the progress bar |
| `--verbose` | Print run logs to stderr |
| `--data-dir <path>` | Use a different data directory |
| `--non-interactive` | Never prompt; fail if confirmation is needed |

## Command groups

```bash
# Connection
udmt connection list | show <name> | test <name> | discover <name> | schema <name> <resource>
udmt connection add --name <name> --provider <id> ...
udmt connection update <name> [--path ...|--host ...|--password-stdin]
udmt connection remove <name>

# Export / Import
udmt export --conn <name> --resource <table> --format jsonl|csv|json [--compression gzip] [--limit N]
udmt import --conn <name> --resource <table> --artifact <id> --mode append|upsert|truncate_and_load

# Artifact
udmt artifact list | verify <id> | prune --older-than-days N --keep-last M [--dry-run]

# Operation
udmt operation list [--limit N] | show <run-id> | logs <run-id> | cancel <run-id>

# Worker / job
udmt job add-export --name <job> ... --schedule daily --hour 2 --timezone Asia/Ho_Chi_Minh
udmt worker run | once | status

# Other
udmt provider list
udmt doctor
udmt gui [--port 4004]      # API + static GUI, same process
udmt serve [--port 4004]    # API only, for `pnpm run dev:gui`
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `2` | Invalid arguments or input |
| `3` | Connection/authentication failure |
| `4` | Operation failure |
| `5` | Cancelled |

## Putting it together

```bash
# Export then import into Postgres, stopping on the first error
ARTIFACT=$(udmt export --conn local-src --resource users --format jsonl --json \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).artifact_id))")
udmt import --conn staging-pg --resource public.users --artifact "$ARTIFACT" --mode upsert --key-columns id
udmt operation list --limit 5
```

> Every command returns errors with a stable code (`NOT_FOUND`, `AUTH_FAILED`, `CONFIRMATION_REQUIRED`, …)
> so scripts can branch on the code instead of parsing a message.
