---
title: Importing data
description: Write modes, upsert keys, table creation and destructive-write confirmation
section: data
order: 4
updated: 2026-11-01
tags: import, upsert, truncate, mapping
---

# Importing data

An import reads from an artifact or an uploaded file and writes into the target table/collection. Rows are
validated against the target schema before they are written.

## Write modes

| Mode | Behaviour | Notes |
|---|---|---|
| `append` | Insert new rows | Default, safest |
| `upsert` | Update on key match, insert otherwise | Needs `--key-columns` |
| `truncate_and_load` | Empty the target, then write | Requires confirmation |

```bash
udmt import --conn target --resource users --artifact <artifact-id> --mode append
udmt import --conn target --resource users --artifact <artifact-id> --mode upsert --key-columns id
udmt import --conn target --resource users --artifact <artifact-id> \
  --mode truncate_and_load --confirm target
```

## In the UI

1. **Import** → pick the target connection and table.
2. Choose an artifact, or upload a CSV/JSON/JSONL file.
3. Pick the mode; for `upsert` select the key columns.
4. For `truncate_and_load`, or any write to a `production` connection, the dialog asks you to type the
   connection name.
5. **Run** → the result panel shows rows read, written and skipped along with warnings.

## Creating the target table

With **Create table if missing** enabled, UDMT builds the table from the source schema (types are mapped
onto the target provider's types). If the table already exists, only matching column names are written;
missing columns show up as warnings instead of being dropped silently.

## Common errors

- **`NOT_FOUND`** — the target table does not exist and table creation is off.
- **`VALIDATION_FAILED`** — some rows do not match the target types; check the per-column warnings.
- **`CONFIRMATION_REQUIRED`** — re-run with `--confirm <connection>` (CLI) or confirm in the UI.
- **Checksum mismatch** — the artifact was modified; run `udmt artifact verify <id>` before importing.
