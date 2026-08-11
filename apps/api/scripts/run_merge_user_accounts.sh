#!/bin/sh
# Runs scripts/merge_user_accounts.sql against the production database.
#
#   ssh -t truenas_admin@192.168.1.34 \
#     'sudo sh /mnt/HDDs/Applications/Dockers/stacks/freeframe-src/apps/api/scripts/run_merge_user_accounts.sh'
#
# Prints no secrets: psql takes its credentials from the postgres
# container's own environment, so nothing from .env.prod is echoed.
#
# The SQL is one transaction with ON_ERROR_STOP=1 — any failed guard or
# assertion rolls the whole thing back. Running it twice is safe: the
# second run aborts at the guard ("already soft-deleted") before touching
# a single row.
set -e

HERE=$(cd "$(dirname "$0")" && pwd)
SQL="$HERE/merge_user_accounts.sql"
[ -f "$SQL" ] || { echo "Missing $SQL"; exit 1; }

CID=$(docker ps --filter "ancestor=postgres:15-alpine" --format '{{.Names}}' | head -1)
[ -n "$CID" ] || CID=$(docker ps --format '{{.Names}}' | grep -i postgres | head -1)
[ -n "$CID" ] || { echo "No postgres container found."; exit 1; }

echo "postgres container: $CID"
echo "Taking a safety dump of the users/membership tables first..."
STAMP=$(date +%Y%m%d-%H%M%S)
DUMP="/tmp/freeframe-premerge-$STAMP.sql"
docker exec -i "$CID" sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t users -t project_members -t votes -t approvals -t comment_reactions' \
  > "$DUMP"
echo "  wrote $DUMP ($(wc -c < "$DUMP") bytes)"
echo

docker exec -i "$CID" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -v ON_ERROR_STOP=1' < "$SQL"
