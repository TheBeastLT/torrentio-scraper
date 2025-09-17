# Torrentio Addon - Local Development Setup

## Quick Start

1. **Prerequisites**:
   - Docker and Docker Compose
   - [Just](https://github.com/casey/just) command runner (optional but recommended)

2. **Clone and setup**:
   ```bash
   git clone <repository-url>
   cd torrentio-scraper/addon
   cp .env.example .env  # Edit .env as needed
   ```

3. **Start development environment**:
   ```bash
   # With just (recommended)
   just dev

   # Or with docker-compose directly
   docker-compose up --build
   ```

4. **Access the application**:
   - Addon: http://localhost:7000
   - Metrics: http://localhost:7000/swagger-stats/ (admin/admin)
   - PostgreSQL: localhost:5432 (torrentio/torrentio)
   - MongoDB: localhost:27017

## Development Commands

If you have `just` installed (you can install it with `brew install just`):


```bash
just                    # List all available commands
just dev               # Start development environment
just dev-detached      # Start in background
just down              # Stop services
just clean             # Stop and remove volumes
just logs              # View all logs
just logs-addon        # View addon logs only
just db-connect        # Connect to PostgreSQL
just mongo-connect     # Connect to MongoDB
just rebuild           # Rebuild and restart
```

Without `just`, use `docker-compose` commands directly:

```bash
docker-compose up --build              # Start development
docker-compose down                    # Stop services
docker-compose logs -f addon          # View addon logs
docker-compose exec addon bash        # Shell into addon container
```

## Database Access

- **PostgreSQL**: `postgres://torrentio:torrentio@localhost:5432/torrentio`
- **MongoDB**: `mongodb://localhost:27017/torrentio-cache`

## Development Notes

- The addon container uses file watching for automatic restarts
- Volumes are configured to persist database data
- Environment variables are set for local development
- Both databases include health checks for reliable startup