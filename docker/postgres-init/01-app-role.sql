-- Runs automatically on first container boot (docker-entrypoint-initdb.d).
-- Creates the non-superuser, non-BYPASSRLS role the app actually connects
-- as. The `postgres` bootstrap user this script runs as IS a superuser in
-- the official postgres image, which would silently bypass every RLS
-- policy (Feature 1's T5) if the app connected as it directly — see
-- docs/decisions/F1-security.md.
CREATE ROLE app_user LOGIN PASSWORD 'app_password' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
GRANT ALL PRIVILEGES ON DATABASE whatsapp_ai_agent TO app_user;
GRANT CREATE ON SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO app_user;

-- Feature 3/A1 (D3): kb_chunks needs pgvector. Image is pgvector/pgvector:pg16
-- (docker-compose.yml), which ships the extension files; still needs an
-- explicit CREATE EXTENSION per-database.
CREATE EXTENSION IF NOT EXISTS vector;

-- Feature 20 (D4): catalog fuzzy search needs pg_trgm. It ships with every
-- Postgres contrib build (including this image), but like `vector` it needs
-- an explicit CREATE EXTENSION per-database, run as this superuser —
-- app_user has no CREATE EXTENSION privilege. Migration 0057_catalog-trgm
-- re-states it with IF NOT EXISTS so a correctly bootstrapped database
-- no-ops there and a misconfigured one fails at migrate time rather than on
-- a live `lookup_product` turn.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
