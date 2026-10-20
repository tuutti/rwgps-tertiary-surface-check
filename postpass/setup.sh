#!/bin/sh
# Download the Finland extract, import it and start Postpass on localhost:8081.
# Re-run with --update to fetch a fresh extract and re-import.
set -eu
cd "$(dirname "$0")"

URL=https://download.geofabrik.de/europe/finland-latest.osm.pbf
PBF=data/finland-latest.osm.pbf

if [ ! -f "$PBF" ] || [ "${1:-}" = "--update" ]; then
  echo "Downloading $URL ..."
  curl -fL --retry 3 -o "$PBF.part" "$URL"
  curl -fsL "$URL.md5" | sed 's#  .*#  data/finland-latest.osm.pbf.part#' | md5sum -c -
  mv "$PBF.part" "$PBF"
fi

docker compose up -d db
docker compose run --rm --build import
docker compose up -d --build postpass

echo
echo "Postpass is running: http://localhost:8081/interpreter"
