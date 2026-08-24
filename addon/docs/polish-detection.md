# Polish release detection

Improves detection and labeling of Polish releases (requested in
[#359](https://github.com/TheBeastLT/torrentio-scraper/issues/359)).

A lot of Polish releases on general trackers (1337x, TPB, TorrentGalaxy) and
Polish MULTi releases are not tagged `PL`/`POLISH`, so `parse-torrent-title`
does not report `polish` for them. As a result they don't get the 🇵🇱 flag in
stream titles and are not prioritized when the user selects Polish as their
priority language. The most common community complaint is MULTi releases with
Polish audio not being recognized as Polish.

## How it works

[`lib/polishDetection.js`](../lib/polishDetection.js) is a dependency-free
module that scores a release/file name against multiple signals:

| Signal | Score | Example |
|---|---|---|
| `lektor` | 4 | `Lektor PL`, `Lektor IVO`, bare `Lektor` |
| `dubbing-pl` | 4 | `Dubbing PL`, `PLDUB`, `PL.DUB`, `DUBPL` |
| `napisy-pl` | 4 | `Napisy PL`, bare `Napisy`, `PLSUB`, `SUBPL` |
| `language-tag` | 4 | standalone `PL` / `POL` token (`www.site.PL` excluded) |
| `polish-word` | 4 | `POLISH`, `polski`, `po polsku` (skipped as the first word, e.g. the movie "Polish Wedding") |
| `polish-phrase` | 3 | `cały film`, `odcinek`/`odc`, `paczka`, `kolekcja`, `miniserial`, `wersja` |
| `polish-site` | 3 | tracker watermarks: `ex-torrenty`, `devil-torrents`, `polskie-torrenty`, `electro-torrent`... |
| `polish-diacritics` | 3 | letters unique to the Polish alphabet: `ą ć ę ł ń ś ź ż` |
| `release-group` | 2 | ~70 curated Polish groups (`K83`, `B89`, `KiT`, `PSiG`, `ANONiM`, `LTS`...), based on regex sets shared by the Polish Stremio community; generic/international tokens (`FLAME`, `FOX`, `KDE`, bare `K`...) deliberately excluded |
| `polish-uploader` | 2 | known Polish uploader handles (`spajk85`, `agusiq`, `marcin0313`...) |
| `polish-domain` | 2 | any `*.pl` domain in the name |
| `polish-provider` | 2 | torrent scraped from a Polish provider (`BestTorrents`) |
| `sezon` | 1 | `Sezon` (weak — also used by Turkish releases) |

`MULTi` alone is **not** a Polish signal (limits false positives), but it adds
+1 when at least one weak Polish signal (score ≥ 2) is present, because Polish
groups/trackers tag releases with Polish audio + original audio as `MULTi`.

The summed score maps to a confidence level instead of a bare boolean:

| Confidence | Score | `isPolish` |
|---|---|---|
| `high` | ≥ 4 | yes |
| `medium` | ≥ 3 | yes |
| `low` | ≥ 1 | no |
| `none` | 0 | no |

```js
import { detectPolishRelease } from './lib/polishDetection.js';

detectPolishRelease('Diuna.Czesc.Druga.2024.MULTi.1080p.BluRay.x264-KiT');
// {
//   isPolish: true, confidence: 'medium', score: 3,
//   signals: ['release-group', 'multi-corroboration'],
//   tags: { lektor: false, dubbing: false, napisy: false, multi: true }
// }
```

`tags` additionally classifies the type of Polish audio (lektor / dubbing /
napisy / multi), which integrators can surface in the UI.

### Integration

`lib/streamInfo.js#getLanguages` appends `polish` to the detected languages
when the module reports `isPolish` (confidence `medium` or higher) for either
the torrent title or the file title. This automatically:

- shows the 🇵🇱 flag in the stream description,
- makes the existing `language=polish` priority sorting (`lib/sort.js`) and
  the language filter work for these releases.

No changes to scrapers, the database or the API are required. The module is
self-contained so it can be reused by companion projects (Jackettio,
AIOStreams, Torznab bridges).

## Running tests

Tests use the built-in `node:test` runner (no new dependencies, Node ≥ 18)
and run fully offline against fixtures in
[`test/fixtures/polishReleases.json`](../test/fixtures/polishReleases.json):

```sh
cd addon
npm install
npm test
```

To try the detector on a single name without a database:

```sh
node --input-type=module -e "import('./lib/polishDetection.js').then(m => console.log(m.detectPolishRelease(process.argv[1])))" "Kler.2018.PL.1080p.WEB-DL.x264-PSiG"
```

## Running the addon locally

The addon serves entries from an already scraped PostgreSQL database
(the scraper code is not part of this repository):

```sh
cd addon
npm install
DATABASE_URI=postgres://user:password@localhost:5432/torrentio npm start
# addon available at http://localhost:7000
```

Or via Docker:

```sh
cd addon
docker build -t torrentio-addon .
docker run -p 7000:7000 -e DATABASE_URI=postgres://user:password@host:5432/torrentio torrentio-addon
```

Optional env vars: `PORT` (default `7000`), `CACHE_MAX_AGE` (seconds),
`METRICS_USER`/`METRICS_PASSWORD` (swagger-stats auth), `MONGODB_URI`/`REDIS_URI`
(cache backends, in-memory cache is used when not set).

## Polish source candidates (status as of 2026-06)

Adding new scraped sources is not possible in this repository (scrapers are
private), so the practical path for more Polish content is Jackett/Prowlarr
(both have indexer definitions for the trackers below) combined with
Torznab-based addons (Jackettio, AIOStreams) — this detection module mirrors
what those projects need to prioritize Polish streams. Quick assessment:

| Source | Reachable | Notes |
|---|---|---|
| best-torrents.net | already scraped | the only Polish provider in Torrentio (`BestTorrents`) |
| ex-torrenty.org | yes (HTTPS) | account required for download links; same engine family as best-torrents |
| polskie-torrenty.eu | yes (HTTPS) | community-recommended for 4K; questionable seed counts |
| electro-torrent.pl | yes (HTTPS) | account required |
| devil-torrents.pl | yes (HTTPS) | account required |
| xtorrenty.org | yes (HTTPS) | account required |
| helltorrents.com | **403** | anti-bot protection, bad scraping candidate |
| pte.nu, rstorrent.org.pl, torrentleech.pl, cinemamovies.pl, exitorrent.org | private | invite/login only, not viable for a public scraper |

## Known limitations

- `polish-word` only skips a leading `Polish ...` — an English title containing
  "Polish" mid-name would still match.
- `ć` is shared with Croatian/Serbian, so a Croatian title using `ć` (and no
  other unique Polish letters) could score `medium`.
- The Polish release-group list is intentionally small and conservative;
  extend `POLISH_GROUPS` in `lib/polishDetection.js` as new groups appear.
- Detection runs on names only — it cannot verify actual audio tracks.
