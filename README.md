# Torrentio Scraper

## Initial dumps

### The Pirate Bay

https://mega.nz/#F!tktzySBS!ndSEaK3Z-Uc3zvycQYxhJA

https://thepiratebay.org/static/dump/csv/

### Kickass

https://mega.nz/#F!tktzySBS!ndSEaK3Z-Uc3zvycQYxhJA

https://web.archive.org/web/20150416071329/http://kickass.to/api

### Migrating Database

When migrating database to a new one it is important to alter the `files_id_seq` sequence to the maximum file id value plus 1.

```sql
ALTER SEQUENCE files_id_seq RESTART WITH <last_file_id + 1>;
```