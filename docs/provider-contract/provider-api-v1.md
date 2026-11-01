# Provider API v1

Source of truth: `src/core/providers/contract.ts`. This document mirrors it for provider authors.

## Descriptor

```ts
interface ProviderDescriptor {
  provider_id: string;            // 'postgresql'
  display_name: string;
  version: string;
  built_in: boolean;
  capabilities: CapabilityDescriptor[]; // every capability, supported=false when absent
  service_profiles: ServiceProfile[];   // supabase, neon, mongodb_atlas…
  config_fields: ProviderConfigField[]; // drives the GUI form and CLI help
  secret_fields: string[];              // never returned by the API
}
```

Capabilities: `test_connection`, `discover_resources`, `read_data`, `write_data`, `schema_read`,
`schema_write`, `bulk_write`, `transactions`, `consistent_snapshot`, `query`, `native_backup`,
`native_restore`.

## Mandatory methods

```ts
validateConfig(config, secret): { config, endpoint_hint }
testConnection(config, secret, ctx): Promise<{ success, server_version, database,
  latency_ms?, diagnostics: string[], detected_capabilities }>
discoverResources(config, secret, ctx): Promise<ResourceDescriptor[]>
```

## Optional capability methods

```ts
readSchema(config, secret, resource, ctx): Promise<ResourceSchema>
readRows(config, secret, request, ctx): AsyncGenerator<RowBatch>
writeRows(config, secret, request, rows, ctx): Promise<WriteResult>
```

- `readRows` must yield batches of `request.batchSize` (or fewer at the end), respect `limit`, and call
  `ctx.throwIfCancelled()` before each batch.
- `writeRows` receives an async iterable of batches and must apply `mode`:
  - `append` — insert only,
  - `upsert` — require `keyColumns`, then conflict-update,
  - `truncate_and_load` — destructive; the engine has already validated confirmation, the provider just
    performs it inside its own transaction where supported.
- Providers must never persist metadata or credentials.

## Resource naming

| Provider | Form | Example |
|---|---|---|
| sqlite | `<table>` | `users` |
| postgresql | `<schema>.<table>` | `public.users` |
| mysql | `<database>.<table>` | `app.users` |
| mongodb | `<database>.<collection>` | `app.customers` |

Identifiers are validated/quoted by each provider; no user string is interpolated into SQL without an
allow-list check (`^[A-Za-z_][A-Za-z0-9_$]*$`) and identifier quoting. Values always use bound
parameters.

## Canonical row values

`Date` → ISO-8601 string, Mongo `ObjectId` → hex string, `Decimal128` → number (string if imprecise),
`Long` → number when safe, `Binary`/`Buffer` → base64 string, nested objects/arrays preserved as JSON.

## Errors

Throw `UdmtError(code, message, {retryable, details})` with `code` from the shared error enum
(`CONNECTION_FAILED`, `AUTH_FAILED`, `NOT_FOUND`, `CAPABILITY_UNSUPPORTED`, `VALIDATION_FAILED`, …).
Messages must be safe to show; strip credentials before including driver text.

## Conformance expectations

A provider is only "supported" when:

1. `validateConfig` rejects malformed input with `INVALID_CONFIG`.
2. `testConnection` distinguishes auth failure from network failure.
3. Every declared capability is actually implemented and tested.
4. Identifier/values are never string-concatenated into SQL.
5. `readRows`/`writeRows` honour cancellation and report progress.
