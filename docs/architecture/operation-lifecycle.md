# Operation lifecycle, cancellation and recovery

## 1. Lifecycle

```
Request → validate → resolve connection/provider/secret/storage → capability check → preflight
        → create durable run (SQLite) → execute (stream batches, progress, logs)
        → finalize artifact/result → verify checksum → persist final state → audit
```

## 2. States

`queued → preparing → preflight → running → finalizing → verifying → completed`

Terminal: `completed`, `completed_with_warnings`, `failed`, `cancelled`, `interrupted`.
Cancellation: `cancel_requested` first, then `cancelled` only after the runtime confirms it stopped.
Dry-run imports skip `running` (`preflight → finalizing → completed`).

The transition table lives in `src/core/state-machine.ts` and is the only place transitions are
declared. Persisting a status goes through `Store.updateRunStatus`, which asserts the transition and
throws `CONFLICT` otherwise. The UI never invents a status; it renders what SQLite says.

## 3. Durable run record

Every run stores: operation type, source/target connection ids and labels, resource, full request
config, stage, progress JSON, result JSON, error code + sanitized message, worker instance, timestamps.
Logs are appended with a per-run sequence so the UI can tail them and reload after a reconnect.

## 4. Progress

Providers report through `OperationContext.progress`. Writes to SQLite are throttled to ~4/sec, while
logs are appended per event. Progress is best-effort and never used to decide terminal state.

## 5. Cancellation

- `udmt operation cancel <run>` (or the GUI) sets `cancel_requested` and aborts the in-process
  `AbortController`.
- Provider loops call `ctx.throwIfCancelled()` before each batch/row; the engine then marks the run
  `cancelled`, deletes the partial export file and its manifest, and records the reason.
- If the run executes in another process, only the request is persisted; the status stays
  `cancel_requested` until that runtime observes it. The CLI prints this explicitly.
- A driver call already in flight is not interrupted — cancellation is between batches. This is a
  documented limitation, not a claim of instant cancellation.

## 6. Recovery

On worker start (`WorkerRuntime.recover`):

1. Runs still active but owned by a missing/stale worker (`heartbeat_at` older than 60s) become
   `interrupted` with an explanatory message.
2. Worker instances with stale heartbeats become `crashed`.
3. Stale task locks are purged after their lease.

Imports are never auto-resumed: a partially written target must be inspected before retrying. Dry-run is
the recommended pre-flight for a retry.

## 7. Locks

| Scope | Owner | Purpose |
|---|---|---|
| `worker.lock` file (pid) | worker process | one worker per data directory |
| `schedule:<id>` | worker instance | prevents double execution of a schedule |
| `connection:<id>` (reserved) | operation | prevents conflicting operations per connection |

Locks carry a heartbeat/lease and are purgeable, so a crash cannot block forever. Locks are local-only;
distributed locking is out of scope for the desktop product.

## 8. Retry policy

Retries are manual and intentional. Destructive operations require a new explicit confirmation; a run
that was `interrupted` must not be retried blindly because its target may be partially written.
`retry_of_run_id` exists in the schema for a future one-click retry that links a new run to the old one.

## 9. Audit

`store.audit()` records connection changes, completed imports/exports, verification failures and
retention deletions with a sanitized detail object. Secrets are never included.
