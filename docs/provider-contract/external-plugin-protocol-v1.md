# External provider protocol v1 (`udmt-provider/1`)

An external provider is a child process that speaks newline-delimited JSON-RPC 2.0 over stdin/stdout.
The core spawns it without a shell, never passes secrets as arguments, and isolates crashes: a plugin
that dies or hangs fails only its own call.

## Manifest (`udmt-plugin.json`)

```jsonc
{
  "manifest_version": 1,
  "id": "com.example.my-provider",     // lowercase [a-z0-9._-], becomes provider_id "plugin:com.example.my-provider"
  "name": "My provider",
  "version": "1.0.0",
  "protocol": "udmt-provider/1",
  "description": "optional",
  "runtime": { "command": "node", "args": ["plugin.mjs"], "cwd": ".", "env": { "FOO": "bar" } },
  "permissions": ["read_config", "read_secrets", "network"],
  "provider": {
    "display_name": "My provider",
    "version": "1.0.0",
    "capabilities": ["test_connection", "discover_resources", "read_data", "schema_read"],
    "config_fields": [ /* same shape as built-in providers */ ],
    "secret_fields": ["token"],
    "service_profiles": []
  }
}
```

Rules:

- `protocol` must equal `udmt-provider/1`; anything else is refused with `CAPABILITY_UNSUPPORTED`.
- The manifest is validated with zod; invalid input is refused with `VALIDATION_FAILED` and the plugin
  is not installed.
- The descriptor is taken from the manifest, so listing providers never starts a process. The live
  handshake happens on the first call.
- `runtime.command`/`args` that start with `./` or `../` resolve relative to the plugin folder. `node`
  is resolved from `PATH`.

## Transport

- One JSON document per line, UTF-8, no length prefix. The host ignores non-JSON stdout lines (they are
  captured as diagnostics, never executed).
- Requests carry a numeric `id`; notifications have no `id`. The host sends one response-less
  `shutdown` notification, then kills the process after a 2 s grace period.
- Every request has a timeout (default 30 s) and honours the run's abort signal: on cancellation the
  host sends `provider.cancel` and rejects the call with `OPERATION_CANCELLED`.
- Errors: return `{"jsonrpc":"2.0","id":N,"error":{"code":<number>,"message":"...","data":{"code":"<UDMT code>"}}}`.
  If `data.code` is a known UDMT error code the host surfaces it verbatim; `-32601` maps to
  `CAPABILITY_UNSUPPORTED`; anything else becomes `OPERATION_FAILED`. Messages are sanitized (bearer/
  basic tokens redacted) before they are shown or stored.

## Methods

| Method | Params | Result |
|---|---|---|
| `initialize` | `{ protocol, client, permissions, plugin_id }` | `{ protocol, server: { name, version }, capabilities }` |
| `provider.testConnection` | `{ config, secret }` | `{ success, server_version, database, latency_ms, diagnostics, detected_capabilities }` |
| `provider.discoverResources` | `{ config, secret }` | `ResourceDescriptor[]` |
| `provider.readSchema` | `{ config, secret, resource }` | `ResourceSchema` |
| `provider.readBatch` | `{ config, secret, request }` | `{ rows, next_offset }` — `next_offset: null` ends the stream |
| `provider.writeBatch` | `{ config, secret, request, rows }` | `{ rows_written, rows_skipped, warnings }` |
| `provider.cancel` (notification) | `{ id }` | none |

The host turns `readBatch` into the provider contract's async generator by looping on `next_offset`,
and turns the engine's async row stream into one `writeBatch` call per batch. `request` mirrors
`ReadRequest`/`WriteRequest` (`resource`, `columns`, `filter`, `limit`, `batchSize`, `offset`, `mode`,
`keyColumns`, `createResource`).

`initialize` must be the first request. `permissions` lists what the user granted; a plugin should
behave safely when a permission is missing (for example, do not read `secret` if `read_secrets` was
not granted).

## Config validation

`validateConfig` on the host side is synchronous and offline: it checks the manifest's required fields
and never starts the process. A plugin can still reject a configuration during `testConnection` or the
first operation.

## Sample plugin and contract tests

`plugins/sample-jsonapi/` is a complete reference implementation (in-memory dataset, paginated reads,
write echo). `tests/integration/plugin-host.test.ts` installs it, grants trust, and runs it through the
real export/import engine, then installs `tests/fixtures/plugins/crash` to prove crash isolation.
