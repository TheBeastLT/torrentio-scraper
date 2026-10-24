# torrentio-catalogs (Rust)

Torrentio catalogs addon. Standalone Cargo project that does not depend on `addon/`.

HTTP surface: `/manifest.json`, `/catalog/{type}/{id}[/{extra}].json` (also under an ignored `/{configuration}` prefix),
`/metrics` (basic auth). The landing page and per-user configuration parsing were dropped.

## Layout

```
src/domain          catalog definitions, genre date ranges, manifest, ports (IdRepository, MetadataSource, CacheStore)
src/application     Catalogs workflow (paging, cache keys, cursor), concurrency limiter, errors
src/infrastructure  Postgres (sqlx), Mongo cache (keyv-compatible documents), Cinemeta/Kitsu client, metrics, logging
src/http            axum routes, CORS, metrics middleware
```

The workflow depends only on the port traits, so it is tested against fakes in `application/catalogs.rs` and
`http/server.rs`.

## Environment

| variable | meaning |
|---|---|
| `DATABASE_URI` | Postgres (required) |
| `MONGODB_URI` | Mongo cache, collection `torrentio_catalog_collection`; without it nothing is cached and `skip` pages are empty |
| `PORT` (7000), `HOST` (`::`) | bind address |
| `TOKIO_MAX_BLOCKING_THREADS` | blocking thread cap (default 8; invalid or 0 falls back) |
| `CACHE_MAX_AGE`, `LIMIT_MAX_CONCURRENT`, `LIMIT_QUEUE_SIZE`, `METADATA_TIMEOUT` | concurrency limiter and metadata settings |
| `METRICS_USER`, `METRICS_PASSWORD` | basic auth for `/metrics` (always 401 when unset) |
| `CINEMETA_URL`, `KITSU_URL` | override the metadata base urls |
| `RUST_LOG` | log filter (default `info`) |

The container entrypoint exports `/run/secrets/{mongodb_uri,database_uri,metrics_user,metrics_password}` as the
upper-case variables.

## Logging

JSON lines, flat fields, no timestamp; warnings and errors to stderr, the rest to stdout. Messages look like
`Incoming catalog ...` and `Failed retrieving catalog ...`.

## Metrics

`/metrics` (basic auth from `METRICS_USER`/`METRICS_PASSWORD`) exports Prometheus text with a constant
`app="torrentio-catalogs"` label. Rows marked
"addon" use the exact name, help text and buckets of the Rust addon.

| name | labels | meaning |
|---|---|---|
| `http_request_duration_seconds` (addon name) | `resource` (manifest, catalog, other) | request duration; feeds `histogram_quantile` (no status label, to keep series low) |
| `http_requests_total` | `resource` | requests by resource (the addon also has a `moch` label) |
| `http_responses_total` | `resource`, `status` | responses by status; carries the status split and error ratios |
| `catalog_requests_total` | `catalog` (3 ids or `unknown`), `outcome` | `ok`, `empty` (valid but no metas), `degraded` (cursor not found or limiter drop), `error` (Postgres, Mongo or metadata failure), `not_found` (unknown catalog id) |
| `metadata_request_duration_seconds` | `source` (cinemeta, kitsu) | Cinemeta/Kitsu call duration; feeds `histogram_quantile` |
| `metadata_requests_total` | `source`, `outcome` (ok, timeout, error) | Cinemeta/Kitsu calls by outcome; carries error ratios |
| `limiter_dropped_total` | none | requests dropped because the concurrency limiter queue was full |
| `limiter_jobs` | `state` (running, queued) | jobs currently in the concurrency limiter |
| `db_pool_connections` (addon) | `state` (size, available, using) | Postgres pool state; no `waiting` state |
| `db_operation_duration_seconds` (addon) | `operation` | Postgres query duration |
| `cache_requests_total` (addon) | `cache` (catalog, ids), `result` (hit, miss) | Mongo cache lookups |
| `cache_operation_duration_seconds` (addon) | `operation` (get, set) | Mongo operation duration |
| `runtime_scheduling_lag_seconds` (addon) | none | delay of a 100ms timer, sampled in the background |
| `runtime_utilization` (addon) | none | share of worker time busy since the previous scrape (0-1) |
| `runtime_alive_tasks` (addon) | none | tasks alive on the async runtime |
| `runtime_global_queue_depth` (addon) | none | tasks waiting in the runtime global queue |
| `process_*` (addon, Linux only) | none | prometheus process collector (CPU, RSS, fds) |

