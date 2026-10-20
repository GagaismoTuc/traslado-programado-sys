DO $bootstrap$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'traslado_migrator') THEN
    CREATE ROLE traslado_migrator LOGIN PASSWORD '{{MIGRATION_PASSWORD}}';
  ELSE
    ALTER ROLE traslado_migrator LOGIN PASSWORD '{{MIGRATION_PASSWORD}}';
  END IF;

  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'traslado_app') THEN
    CREATE ROLE traslado_app LOGIN PASSWORD '{{APPLICATION_PASSWORD}}';
  ELSE
    ALTER ROLE traslado_app LOGIN PASSWORD '{{APPLICATION_PASSWORD}}';
  END IF;

  EXECUTE format('GRANT CREATE ON DATABASE %I TO traslado_migrator', current_database());
END
$bootstrap$;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO traslado_migrator;
GRANT USAGE ON SCHEMA public TO traslado_app;
ALTER ROLE traslado_migrator SET timezone TO 'UTC';
ALTER ROLE traslado_app SET timezone TO 'UTC';
ALTER DEFAULT PRIVILEGES FOR ROLE traslado_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO traslado_app;
ALTER DEFAULT PRIVILEGES FOR ROLE traslado_migrator IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO traslado_app;
