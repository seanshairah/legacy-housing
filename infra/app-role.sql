-- Run as migration owner after creating the dedicated application login through secure provisioning.
-- Never use these grants on the reference application's database.
GRANT CONNECT ON DATABASE legacy_dev TO legacy_app;
GRANT USAGE ON SCHEMA public TO legacy_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO legacy_app;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO legacy_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO legacy_app;
-- Do not grant TRUNCATE, DDL, superuser, or ownership of the immutable-evidence triggers.
-- Separate the migrator and runtime roles. Substitute the verified production database name.
