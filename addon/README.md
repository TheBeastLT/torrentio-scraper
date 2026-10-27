# torrentio-addon

The Torrentio Stremio addon in Rust. HTTP surface: `/manifest.json`, `/configure`, `/{config}/stream|meta|catalog/...`,
`/resolve/...`, `/metrics` and the static files in `static/`. It uses the Postgres torrents schema, the Mongo cache
collections and the Redis rate limiter keys shared with the other Torrentio services, and exports the same Prometheus
metric names for everything that still applies.

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

Torrent titles are parsed with the Rust `parse-torrent-title` crate.

Dependencies are injected at the seams: the workflows depend on the `TorrentRepository` trait, and `Mochs::new` takes the
provider list (`default_providers` builds the real ones), so whole stream/resolve flows are tested against fakes in
`application/addon.rs`.

## Running

```
DATABASE_URI=postgres://... MONGODB_URI=mongodb://... REDIS_URL=redis://... \
METRICS_USER=... METRICS_PASSWORD=... PORT=7000 STATIC_DIR=static \
cargo run --release -p torrentio-addon
```

`MONGODB_URI` and `REDIS_URL` are optional (no store cache / no rate limiting without them). `MONGODB_DATABASE` overrides
the database of the Mongo cache collections, `HOST` the bind address (default `::`). `TORBOX_API_URL` and
`HIGHWAY_API_BASE` override the provider API base urls. The Docker image is built from this directory: 
`docker build -t torrentio-addon .`

## Logging

One JSON object per line, flat fields, no timestamp (the Docker/Alloy pipeline adds it): warnings and errors go to
stderr, the rest to stdout. Message prefixes match the Node addon so existing Loki greps keep working
(`{service="torrentio_addon"} |= "Failed RealDebrid"`), and the details are fields (`| json | moch="torbox"`).

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
| Memory (RSS), benchmark | ~370 MB | ~1.5 GB | 60-80 MB (idle, small cache) |

With Redis in the loop the hot path is bounded by Redis itself for both implementations (without Redis the Rust server does
60-80k req/s); the gains show on the cold and debrid paths and in memory.

In production a Node process sat at 0.8-1.7 GB. The Rust process starts around 0.25 GB and grows with the stream cache, which
holds zstd-compressed JSON (about 5.5 KB per entry, an 800 MB budget by default).
