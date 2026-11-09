---
title: Managing artifacts
description: Verify integrity, pin important files and prune by retention policy
section: automation
order: 6
updated: 2026-11-01
tags: artifact, checksum, retention, cleanup
---

# Managing artifacts

An artifact is the output file of an export, together with its manifest and checksum. The **Artifacts**
page is where you inspect, verify and clean them up.

## Verifying integrity

```bash
udmt artifact list
udmt artifact verify <artifact-id>
```

Verify recomputes the file's SHA-256 and compares it with the value recorded at export time. On a
mismatch the related run is marked `failed` with a checksum error — that is how you catch a file that was
edited or truncated after the fact.

## Pinning

A pinned file is **never** removed by retention. Use it for milestone backups, reconciliation data or
files still to be handed over. Toggle it with the pin button in the UI.

## Pruning

```bash
udmt artifact prune --older-than-days 30 --keep-last 5 --dry-run
udmt artifact prune --older-than-days 30 --keep-last 5
```

Safety rules during prune:

- Always start with `--dry-run` to see which files would go.
- Pinned files are skipped.
- Files outside the storage root are skipped and reported.
- The manifest is deleted with its file, so no orphans are left behind.

## Anatomy of an artifact

```
<storage-root>/<artifact-id>/<conn>-<resource>-<timestamp>.jsonl.gz
<storage-root>/<artifact-id>/<file>.manifest.json
```

The manifest holds the columns and types, row count, checksum, provider, run parameters and warnings.
Because of it, the file can still be imported elsewhere once the catalog is gone.

## Remote storage (S3, R2, MinIO, B2)

Artifacts can live in S3-compatible object storage instead of the local data directory. Add a backend on
the **Storage** page (or with the CLI):

```bash
udmt storage add --name r2-backups --type s3 --endpoint https://<account>.r2.cloudflarestorage.com \
  --bucket udmt-artifacts --prefix udmt --access-key-id <key> --secret-access-key-stdin
udmt storage test r2-backups
udmt storage default r2-backups
```

- Credentials are write-only: they are stored in the encrypted vault and never written to the catalog,
  logs or exports.
- Exports still stream to a local staging file first, then upload the data file and its manifest. The
  catalog records an `s3://bucket/key` locator.
- Imports download the object to staging before the normal streaming import, then remove the temporary
  file.
- Deleting a backend is refused while it still owns artifacts or is the default backend.
