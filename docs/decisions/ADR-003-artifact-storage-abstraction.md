# ADR-003 — Artifact storage kept separate from providers

**Status:** Accepted.

## Context

Backups and exports produce files. The roadmap requires that "where the artifact lives" is independent
from "which database produced it", and that future object storage (S3/R2/MinIO) can be added without
touching providers.

## Decision

- Providers only produce/consume **row streams**. They never write artifact files or metadata.
- The engine writes data through `createFormatWriter` into a path resolved by `LocalStorageBackend`:
  - managed mode: `<data-dir>/artifacts/<run-id>/…` (default),
  - external mode: an explicitly supplied directory, flagged in the manifest as `output_mode: external`.
- Every artifact gets a `.manifest.json` sidecar plus a catalog row (`artifacts` table) with checksum,
  size, format, provider, source label, verification and pin state.
- Retention cleanup deletes only catalogued files (or the exact external file it created), never
  arbitrary paths, and skips pinned artifacts and files outside the managed root unless they were
  explicitly created there.

## Consequences

- Re-import needs only the data file + sidecar manifest — no local catalog (portable artifacts).
- S3/R2 support means adding a backend interface and a different writer; the engine contract stays.
- Artifact paths are validated (`assertSafePath`), and `..`/NUL/segment abuse is rejected.
