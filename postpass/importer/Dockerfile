FROM debian:trixie-slim
# postpass.lua needs osm2pgsql >= 2.2 (spherical_length/area); trixie has 2.1, backports has 2.3.
RUN echo 'deb http://deb.debian.org/debian trixie-backports main' > /etc/apt/sources.list.d/backports.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends -t trixie-backports osm2pgsql \
 && apt-get install -y --no-install-recommends postgresql-client ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY import.sh /import.sh
ENTRYPOINT ["/bin/sh", "/import.sh"]
