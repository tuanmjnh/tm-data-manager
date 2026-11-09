# Plugin trust model

External providers run arbitrary code on the user's machine. The trust model keeps the decision
explicit and the blast radius small.

## Lifecycle states

1. **Installed** - the manifest is validated and stored. Nothing is executed and no provider is
   exposed to the engine or GUI.
2. **Trusted** - the user grants a subset of the permissions the manifest requested. Only then can the
   plugin be enabled and its provider registered as `plugin:<id>`.
3. **Enabled** - the provider appears in the provider list and can be used by connections. The process
   is spawned lazily on the first call.
4. **Revoked / disabled / removed** - trust is dropped, the provider is unregistered, the process is
   stopped, and only then is the record deleted. Files are never deleted by the core.

`setPluginEnabled(id, true)` on an untrusted plugin is refused with `PRECONDITION_FAILED`. Granting a
permission the manifest did not request is refused with `INVALID_INPUT`, so a plugin cannot silently
gain a capability later.

## Permissions

| Permission | Meaning |
|---|---|
| `read_config` | Read connection config for this provider |
| `read_secrets` | Receive the decrypted credential payload for a connection |
| `network` | Make outbound network requests |
| `filesystem` | Read/write local files |
| `write_data` | Write to target data sources |

The granted set is sent to the plugin during `initialize` and is also the value shown in the UI. A
connection's secret is only sent to the plugin when `read_secrets` was granted **and** that connection
uses the plugin's provider; the host does not forward secrets for other connections.

## Isolation and limits

- No shell: the process is spawned with `shell: false`; secrets never appear in argv.
- Crashes are contained: a dead or hanging plugin rejects its own calls with `CONNECTION_FAILED`; built-in
  providers and the GUI keep working (covered by the crash-isolation test).
- Timeouts: every call has a deadline (30 s default). A timed-out call is rejected, not silently retried
  forever.
- Cancellation: cancelling a run aborts the in-flight plugin calls.
- Output handling: stdout must be newline-delimited JSON; other lines are captured as diagnostics, not
  executed. Diagnostics and error messages are redacted and truncated before storage or display.
- A plugin can never write to the metadata SQLite database: only `Store` does.

## What the host does not guarantee

- A plugin is not sandboxed at the OS level. A trusted plugin runs with the same OS rights as the core;
  grant `filesystem`/`network` only to code you trust.
- The manifest is declarative: capabilities can be over-claimed. The core enforces the *permission*
  boundary and protocol shape, not the plugin's honesty. Review the source of a plugin before trusting
  it.
- Plugin package signing, automatic updates and a marketplace are out of scope for Phase 7.
