#!/bin/sh
set -e

for name in redis_url mongodb_uri database_uri metrics_user metrics_password; do
  file="/run/secrets/$name"
  if [ -f "$file" ]; then
    export "$(printf '%s' "$name" | tr '[:lower:]' '[:upper:]')=$(cat "$file")"
  fi
done

exec node --insecure-http-parser index.js
