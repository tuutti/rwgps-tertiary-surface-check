#!/bin/sh
# Imports /data/$PBF into PostGIS with the Postpass schema (replaces existing tables).
set -eu
PBF="/data/${PBF:-finland-latest.osm.pbf}"

osm2pgsql --create --slim --drop \
  --output=flex --style=/postpass.lua \
  --cache="${OSM2PGSQL_CACHE:-2000}" \
  --number-processes="${OSM2PGSQL_PROCS:-8}" \
  "$PBF"

psql -v ON_ERROR_STOP=1 -c 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO readonly' -c 'ANALYZE'
echo "Import of $PBF done."
