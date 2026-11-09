# REST provider (`rest`)

The `rest` provider adapts a JSON HTTP API to the provider contract so it can be exported from,
imported into and synced like any database. It is a built-in provider (`provider_id: "rest"`).

## Capabilities

| Capability | Supported | Notes |
|---|---|---|
| `test_connection` | yes | `GET` the base URL / first resource, reports HTTP status and latency |
| `discover_resources` | yes | From the configured `resources` list |
| `read_data` | yes | Paginated row reading |
| `schema_read` | yes | Sampled from up to 5 rows (canonical types) |
| `write_data` | yes | Append only (POST/PUT/PATCH) |
| `bulk_write` | yes | Batch array body by default |
| `schema_write`, `upsert`, `truncate_and_load` | no | Refused with `CAPABILITY_UNSUPPORTED`, never faked |

## Configuration

| Field | Required | Default | Purpose |
|---|---|---|---|
| `base_url` | yes | — | `http(s)` origin + base path; resource paths resolve against it |
| `resources` | no | — | Comma-separated endpoint paths; also used for discovery |
| `items_path` | no | `data` | Dot path to the row array; empty means the response root is the array |
| `headers` | no | — | JSON object of extra non-secret headers (Authorization/Cookie rejected) |
| `auth_type` | no | `none` | `none` \| `bearer` \| `api_key` \| `basic` |
| `auth_header` | no | `X-API-Key` | Header used for `api_key` when no query parameter is set |
| `auth_query_param` | no | — | Send the API key as this query parameter instead |
| `username` | basic only | — | Basic auth user |
| `page_mode` | no | `page` | `none` \| `page` \| `offset` \| `cursor` \| `link` |
| `page_param` | no | `page` | Page / offset parameter name |
| `cursor_param` | no | `cursor` | Cursor parameter name |
| `page_size_param` | no | `limit` | Page size parameter name |
| `page_size` | no | `100` | Rows per request |
| `next_path` | no | `next` | Response dot path holding the next cursor |
| `timeout_ms` | no | `30000` | Per-request timeout |
| `rate_limit_per_minute` | no | `0` | Client-side throttle (`0` disables) |
| `retry_attempts` | no | `2` | Extra attempts on 429/5xx/network errors |
| `retry_backoff_ms` | no | `500` | Base backoff (`Retry-After` wins when present) |
| `write_method` | no | `POST` | `POST` \| `PUT` \| `PATCH` |
| `write_path` | no | resource | Endpoint override for writes |
| `write_batch` | no | `true` | Send each batch as a JSON array instead of one row per request |

Secrets (`token`, `api_key`, `password`) are stored in the encrypted vault. At creation they may be
passed inline (`bearer_token`, `api_key`, `password`) and `normalizeInlineSecret` moves them out of
`config` before it is persisted.

Pagination stops when a page is shorter than `page_size` (page/offset), when the cursor path is empty
(cursor) or when there is no `rel="next"` link (link). Rows from every page form one stream.

## Example

```jsonc
{
  "base_url": "https://api.example.com/v1",
  "resources": "users, orders",
  "items_path": "data",
  "auth_type": "bearer",
  "page_mode": "cursor",
  "cursor_param": "cursor",
  "next_path": "meta.next",
  "page_size": 200
}
```

CLI:

```bash
udmt connection add --provider rest --name crm \
  --config '{"base_url":"https://api.example.com/v1","resources":"users","items_path":"data","auth_type":"bearer"}' \
  --password-stdin
udmt connection test crm
udmt export --conn crm --resource users --format jsonl --out ./exports
udmt sync pipeline create --name crm-users --source-conn crm --target-conn warehouse \
  --source-resource users --target-resource users --mode upsert --key-columns id
```

## Safety

- Redirects are not followed (a 3xx is an error), so a compromised endpoint cannot bounce a request.
- Pagination `next` links and resource paths must share the configured origin.
- API keys are sent in a header unless a query parameter is explicitly configured; the diagnostics and
  endpoint hint never include secrets.
- `writeRows` refuses destructive modes; a REST target can only be appended to.

## Verified scope

Tested against a local HTTP server (pagination by page, bearer/API-key auth, 401 handling, multi-page
read → artifact → SQLite import). No live third-party API, TLS pinning or OAuth2 was exercised in this
environment.
