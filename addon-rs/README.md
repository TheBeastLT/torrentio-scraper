# torrentio-addon (Rust)

Rust port of the Torrentio Stremio addon in `../addon`. Same HTTP surface (`/manifest.json`, `/configure`,
`/{config}/stream|meta|catalog/...`, `/resolve/...`, `/metrics`, static files), same Postgres schema, same Mongo
cache collections (entries written by the Node addon are readable by this one and vice versa), same Redis rate limiter
keys and the same Prometheus metric names for everything that still applies.

## Layout

```
crates/addon    the server, organised in layers
  domain          pure logic: typed configuration, filtering, sorting, stream rendering, models, repository port
  application     stream / catalog / meta workflows (Addon), HandlerError
  providers       debrid adapters (Moch trait), provider registry, resolve outcomes, circuit breakers
  infrastructure  Postgres, Mongo, Redis, caches, metrics, logging, concurrency helpers
  http            axum routes, middleware, landing page, manifest
crates/debrid   minimal HTTP clients, one module per debrid provider, only the endpoints the addon calls
bench/load.js   k6 scenario used for the Node vs Rust comparison
```

Torrent titles are parsed with the Rust `parse-torrent-title` crate (git dependency on its `rust` branch).

Dependencies are injected at the seams: the workflows depend on the `TorrentRepository` trait, and `Mochs::new` takes the
provider list (`default_providers` builds the real ones), so whole stream/resolve flows are tested against fakes in
`application/addon.rs`.

## Running

```
DATABASE_URI=postgres://... MONGODB_URI=mongodb://... REDIS_URL=redis://... \
METRICS_USER=... METRICS_PASSWORD=... PORT=7000 STATIC_DIR=../addon/static \
cargo run --release -p torrentio-addon
```

`MONGODB_URI` and `REDIS_URL` are optional (no store cache / no rate limiting without them). `MONGODB_DATABASE` overrides
the database of the Mongo cache collections, `HOST` the bind address (default `::`). `TORBOX_API_URL` and
`HIGHWAY_API_BASE` override the provider API base urls. `RUST_LOG` sets the log filter (default `info`). The Docker image
is built from the repository root: `docker build -f addon-rs/Dockerfile .`

## Logging

One JSON object per line, flat fields, no timestamp (the Docker/Alloy pipeline adds it): warnings and errors go to
stderr, the rest to stdout. Message prefixes match the Node addon so existing Loki greps keep working
(`{service="torrentio_addon"} |= "Failed RealDebrid"`), and the details are fields (`| json | moch="torbox"`).

## Metrics

Same names as the Node addon except the runtime ones, which are Rust-native:

| Node | Rust |
|---|---|
| `nodejs_eventloop_utilization` | `runtime_utilization` |
| `nodejs_eventloop_lag_p90/p99_seconds` | `histogram_quantile(q, rate(runtime_scheduling_lag_seconds_bucket[..]))` |
| `nodejs_heap_size_used_bytes`, `nodejs_gc_duration_seconds_sum` | none (no GC); use `process_resident_memory_bytes` |
| `db_pool_connections{state="waiting"}` | same name, counts in-flight connection acquires |

Also exported: `runtime_alive_tasks`, `runtime_global_queue_depth`.

## Checks

```
cargo fmt --all --check
cargo clippy --workspace --all-targets
cargo test --workspace
```

## Benchmark

`bench/load.js` drives `/stream` requests with k6 against a local Postgres copy (8M torrents, 16M files), Redis and
Mongo, 64 concurrent connections, a distinct client IP per request so the rate limiter never triggers:

```
BASE=http://127.0.0.1:7002 MODE=hot  TARGETS=hot_targets.txt  VUS=64 k6 run bench/load.js
BASE=http://127.0.0.1:7002 MODE=cold TARGETS=cold_targets.txt VUS=64 k6 run bench/load.js
```

Targets are `<type> <id>` lines. `hot` repeats 100 ids against a warm memory cache, `cold` requests 3000 distinct ids
once against empty caches. Add `CONFIG=torbox=<key>` to include a debrid availability call per request. Flush Redis
between runs: every run leaves about a million rate-limit keys behind and a bloated keyspace slows the benchmark itself.

Results on one machine (14 cores), clean Redis, Node as deployed (1 worker) and with 4 workers:

| Scenario | Node, 1 worker | Node, 4 workers | Rust, 1 process |
|---|---|---|---|
| Hot stream cache, req/s | 15.4k | 49.2k | 52.1k |
| Cold, Postgres, req/s | 635 | 1,778 | 3,004 |
| Hot + TorBox availability call, req/s | 5.1k | 14.0k | 30.2k |
| Memory (RSS) | ~370 MB | ~1.5 GB | 60-80 MB |

With Redis in the loop the hot path is bounded by Redis itself for both implementations (without Redis the Rust server does
60-80k req/s); the gains show on the cold and debrid paths and in memory.

## Shadow test against the running Node addon

`deploy/shadow-stack.yml` runs this image as its own swarm service next to the Node addon on one node: loopback only
(`127.0.0.1:19786`), no nginx routing, a separate Mongo database, no rate limiter, capped CPU and memory. The image is
cross-compiled for amd64 and loaded onto the node, then deployed without registry resolution:

```
docker buildx build --platform linux/amd64 -f addon-rs/Dockerfile -t torrentio-addon-rs:rs-shadow-N --load .
docker save torrentio-addon-rs:rs-shadow-N | gzip | ssh <node> 'gunzip | docker load'
DOCKER_HOST=ssh://<manager> RS_TAG=rs-shadow-N docker stack deploy --resolve-image never -c deploy/shadow-stack.yml rs-shadow
```

`shadow/compare.mjs` talks to both addons through an ssh tunnel (`-L 19785:127.0.0.1:19785 -L 19786:127.0.0.1:19786`):
it diffs the stream lists and, for every provider key present in the environment (`RD_KEY`, `AD_KEY`, `PM_KEY`, `DL_KEY`,
`TB_KEY`, `OC_KEY`, `ED_KEY`, `PUTIO_KEY`, `HW_KEY`), resolves the same cached streams on both and compares which file
each picked. Stream differences are expected from Node's up to 3 day old Mongo cache, ties at the 500 row limit and the
newer title parser; a resolve difference is a finding. Remove with `docker stack rm rs-shadow`.
