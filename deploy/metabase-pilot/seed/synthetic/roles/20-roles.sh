#!/bin/bash
# 20-roles.sh — create the read-only role Metabase connects as.
#
# A shell wrapper rather than a plain .sql because the password comes from the
# container environment and must never be written into a file. The entrypoint
# runs *.sql without psql variables, so the SQL lives in lib/ (which the
# entrypoint does not recurse into) and is invoked from here with the value
# bound at run time.
set -euo pipefail

if [ -z "${PILOT_REPORTING_READONLY_PASSWORD:-}" ]; then
  echo "20-roles.sh: PILOT_REPORTING_READONLY_PASSWORD is not set" >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 \
     --username "$POSTGRES_USER" \
     --dbname "$POSTGRES_DB" \
     -v readonly_password="$PILOT_REPORTING_READONLY_PASSWORD" \
     -f /docker-entrypoint-initdb.d/lib/roles.sql

echo "20-roles.sh: metabase_readonly created (SELECT only)."
