---
title: Exporting data
description: File formats, compression, row limits and the manifest that ships with each artifact
section: data
order: 3
updated: 2026-11-01
tags: export, csv, jsonl, gzip
---

# Exporting data

Exports stream rows, so table size never has to fit in memory, and every run is recorded as a durable
**run** you can inspect afterwards.

## Formats

| Format | Shape | Good for |
|---|---|---|
| `jsonl` | One JSON object per line | Moving between systems, safe with nested documents |
| `json` | A single array, written incrementally | Handing data to another tool |
| `csv` | Header + rows, correctly escaped | Opening in Excel/Sheets |

Add gzip compression with `--compression gzip`.

## In the UI

1. **Export** → pick the source connection.
2. Choose a table (press **Discover** if the list is empty).
3. Pick the format, compression and an optional row limit.
4. **Run** and follow the progress panel; a link to the artifact appears when it finishes.

## From the CLI

```bash
udmt export --conn local-src --resource users --format jsonl --compression gzip
udmt export --conn local-src --resource users --format csv --limit 1000
udmt export --conn local-src --resource users --columns id,email
```

The command prints the artifact id, row count, size and the verified SHA-256.

## Manifest

Every artifact gets a `<file>.manifest.json` alongside it holding the column list, data types, row count,
checksum, provider and any warnings. That is what lets the file be imported on another machine even when
the catalog is gone.

## Safety rules

- Output paths must live inside the storage root; writing outside it is recorded as
  `output_mode: external` and logged as a warning.
- A run can be cancelled midway; it ends as `cancelled` and the partial artifact is never marked
  complete.
- Providers that cannot read return `CAPABILITY_UNSUPPORTED` instead of producing an empty file.
