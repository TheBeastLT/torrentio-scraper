# Database Migration Guide

This guide shows how to create the required database tables for the Torrentio addon.

## Prerequisites

1. **Docker and Docker Compose** installed
2. **Node.js** installed (for running the migration script)

## Method 1: Using Docker Compose (Recommended)

### Step 1: Start the PostgreSQL database
```bash
cd addon
docker-compose up postgres -d
```

### Step 2: Run the migration script
```bash
# From the addon directory
npm run create-tables

# Or directly
node create-tables.js
```

## Method 2: Using existing PostgreSQL instance

### Step 1: Set up your database
Create a PostgreSQL database named `torrentio` with user `torrentio` and password `torrentio`.

### Step 2: Set environment variable (optional)
```bash
export DATABASE_URI="postgres://torrentio:torrentio@localhost:5432/torrentio"
```

### Step 3: Run the migration
```bash
cd addon
node create-tables.js
```

## What the script creates

The migration script creates three tables:

1. **`torrents`** - Stores torrent metadata
   - `infoHash` (primary key)
   - `provider`, `title`, `size`, `type`
   - `uploadDate`, `seeders`, `trackers`
   - `languages`, `resolution`

2. **`files`** - Stores individual files within torrents
   - `id` (auto-increment primary key)
   - `infoHash` (foreign key to torrents)
   - `fileIndex`, `title`, `size`
   - `imdbId`, `imdbSeason`, `imdbEpisode` (for movies/TV)
   - `kitsuId`, `kitsuEpisode` (for anime)

3. **`subtitles`** - Stores subtitle file information
   - `infoHash` (foreign key to torrents)
   - `fileIndex`, `fileId` (foreign key to files)
   - `title`, `size`

## Troubleshooting

- **Connection refused**: Make sure PostgreSQL is running
- **Database doesn't exist**: Create the `torrentio` database first
- **Permission denied**: Check database user permissions
- **Tables already exist**: The script will skip existing tables (use `force: true` in the script to recreate them)

## Next Steps

After creating the tables, you'll need to populate them with torrent data. This addon only queries existing data - it doesn't scrape or ingest torrents. You'll need a separate service to populate the database with torrent metadata.
