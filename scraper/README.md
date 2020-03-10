# Torrentio Scraper

## Initial dumps

### The Pirate Bay

https://mega.nz/#F!tktzySBS!ndSEaK3Z-Uc3zvycQYxhJA

https://thepiratebay.org/static/dump/csv/

### Kickass

https://mega.nz/#F!tktzySBS!ndSEaK3Z-Uc3zvycQYxhJA

https://web.archive.org/web/20150416071329/http://kickass.to/api

### RARBG

Scrape movie and tv catalog using [www.webscraper.io](https://www.webscraper.io/) for available `imdbIds` and use those via the api to search for torrents.

Movies sitemap
```json
{"_id":"rarbg-movies","startUrl":["https://rarbgmirror.org/catalog/movies/[1-4110]"],"selectors":[{"id":"rarbg-movie-imdb-id","type":"SelectorHTML","parentSelectors":["_root"],"selector":".lista-rounded table td[width]","multiple":true,"regex":"tt[0-9]+","delay":0}]}
```

TV sitemap
```json
{"_id":"rarbg-tv","startUrl":["https://rarbgmirror.org/catalog/tv/[1-609]"],"selectors":[{"id":"rarbg-tv-imdb-id","type":"SelectorHTML","parentSelectors":["_root"],"selector":".lista-rounded table td[width='110']","multiple":true,"regex":"tt[0-9]+","delay":0}]}
```

### Migrating Database

When migrating database to a new one it is important to alter the `files_id_seq` sequence to the maximum file id value plus 1.

```sql
ALTER SEQUENCE files_id_seq RESTART WITH <last_file_id + 1>;
```