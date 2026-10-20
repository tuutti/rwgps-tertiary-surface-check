-- Postpass connects as this read-only user (runs once, on first DB start).
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE USER readonly WITH PASSWORD 'readonly';
ALTER ROLE readonly SET statement_timeout = '120s';
GRANT USAGE ON SCHEMA public TO readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO readonly;
-- Tables osm2pgsql creates later (as user postpass) become readable too.
ALTER DEFAULT PRIVILEGES FOR ROLE postpass IN SCHEMA public GRANT SELECT ON TABLES TO readonly;
