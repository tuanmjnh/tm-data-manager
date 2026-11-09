# ADR-003 — Artifact storage kept separate from providers

**Status:** Accepted. Implemented in Phase 4 (`src/core/storage/**`).

## Context

Backups and exports produce files. The roadmap requires that "where the artifact lives" is independent
from "which database produced it", and that future object storage (S3/R2/MinIO) can be added without
touching providers.

## Decision

- Providers only produce/consume **row streams**. They never write artifact files or metadata.
- The engine always writes to a **local staging file** first, through a `StorageBackend`
  (`src/core/storage/contract.ts`):
  - `prepareStagingDir(runId)` returns a run-scoped directory under `<data-dir>/tmp/staging`.
  - `putObject` publishes the finished file (no-op for local backends), `getObject` materializes a
    remote object before import, and `describeObject` returns the catalog locator
    (absolute path for local, `s3://bucket/key` for S3).
- Backends today:
  - `local` — managed mode writes `<data-dir>/artifacts/<run-id>/…` (default, `local-default`), and an
    explicitly supplied `output_dir` is flagged in the manifest as `output_mode: external`.
  - `s3` — S3-compatible object storage (AWS, Cloudflare R2, MinIO, Backblaze B2) signed with SigV4 in
    `fetch`; path-style addressing defaults on. Credentials live in the encrypted vault, never in the
    backend catalog row or logs.
- Every artifact gets a `.manifest.json` sidecar plus a catalog row (`artifacts` table) with checksum,
  size, format, provider, source label, verification and pin state. Remote objects store the sidecar in
  the same bucket/prefix.
- Retention cleanup deletes only catalogued objects through their backend, never arbitrary paths, and
  skips pinned artifacts and files outside the managed root unless they were explicitly created there.

## Consequences

- Re-import needs only the data file + sidecar manifest — no local catalog (portable artifacts).
- Adding a backend means implementing the `StorageBackend` contract and registering a factory case; the
  operation engine and providers stay unchanged.
- Imports from S3 pay one download to `tmp/staging` before the existing streaming import path runs.
- Artifact paths are validated (`assertSafePath`), and `..`/NUL/segment abuse is rejected. S3 prefixes
  reject `..`, and bucket/endpoint errors are surfaced as typed `STORAGE_ERROR`s with sanitized
  endpoint hints.
