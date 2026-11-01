# ADR-001 — Hybrid provider architecture

**Status:** Accepted (contract laid down; external plugin host deferred to Phase 7).

## Context

The roadmap requires adding data sources (databases, files, APIs) without rewriting the operation
engine, scheduler, artifact catalog or GUI. Two mechanisms were considered: compiling everything into
the core, or loading third-party providers as dynamic libraries.

## Decision

1. **Built-in providers** live in the core process and implement the typed `DataProvider` contract.
   They ship with the app and are trusted.
2. **External providers** will run as separate processes speaking a versioned JSON-RPC protocol over
   stdio (Phase 7). No dynamic libraries in-process.

## Consequences

- Contract-first: descriptors, capabilities, errors and row batches are provider-agnostic; the engine
  never branches on a provider id.
- New built-in providers are additive (implement the interface, register it).
- External providers need a manifest, handshake, permission model and crash isolation, which is
  deliberately not implemented yet. Nothing in this build pretends that it is.
- Capability enforcement exists today (`CAPABILITY_UNSUPPORTED`), so a future plugin that under-delivers
  cannot be presented as working.
