-- Least-privilege database roles (V2 §9). Idempotent. Applied to ONE database by scripts/db-roles.ts
-- (run as the database owner / bootstrap superuser) before and after migrations.
--   socialite_migrator  owns the schema objects; the ONLY role that runs DDL (migrations).
--   socialite_app       web application: DML only on application tables; audit_events is append-only.
--   socialite_worker    background worker: same DML as the app; additionally owns the pg-boss queue schema
--                       (pg-boss creates/maintains its own tables there). No DDL on the application schema.
-- None of them is a superuser, can create roles or databases, or bypasses row security.
-- Login roles (and their passwords) are created by scripts/db-roles.ts from the configured URLs; in production
-- they are provisioned by the platform and this file is applied by the migration job.

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO socialite_migrator, socialite_app, socialite_worker', current_database());
  -- pg-boss installs its own schema on first start (CREATE SCHEMA needs database-level CREATE).
  EXECUTE format('GRANT CREATE ON DATABASE %I TO socialite_worker', current_database());
  EXECUTE format('REVOKE CREATE ON DATABASE %I FROM socialite_app', current_database());
END $$;

-- Extensions used by the migrations (001_core.sql). Creating an extension needs the database owner, so this owner-run
-- file installs them; the migrator's own CREATE EXTENSION IF NOT EXISTS then becomes a no-op.
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Application schema: only the migrator may create objects in it.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO socialite_migrator;
GRANT USAGE ON SCHEMA public TO socialite_app, socialite_worker;

-- Existing objects created by a bootstrap superuser move to the migrator (extension members are left alone;
-- sequences owned by a column move with their table).
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS obj, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S','f')
       AND pg_get_userbyid(c.relowner) <> 'socialite_migrator'
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
       AND NOT (c.relkind = 'S' AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('a','i')))
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO socialite_migrator',
      CASE r.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END, r.obj);
  END LOOP;
  FOR r IN
    SELECT p.oid::regprocedure AS fn, p.prokind FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) <> 'socialite_migrator'
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO socialite_migrator', CASE r.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE' ELSE 'FUNCTION' END, r.fn);
  END LOOP;
  FOR r IN
    SELECT t.oid::regtype AS typ FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public' AND t.typtype IN ('e','d') AND pg_get_userbyid(t.typowner) <> 'socialite_migrator'
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER TYPE %s OWNER TO socialite_migrator', r.typ);
  END LOOP;
  -- pg-boss queue schema (if already installed) belongs to the worker.
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pgboss') THEN
    EXECUTE 'ALTER SCHEMA pgboss OWNER TO socialite_worker';
    FOR r IN
      SELECT c.oid::regclass AS obj, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'pgboss' AND c.relkind IN ('r','p','v','S') AND pg_get_userbyid(c.relowner) <> 'socialite_worker'
         AND NOT (c.relkind = 'S' AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('a','i')))
    LOOP
      EXECUTE format('ALTER %s %s OWNER TO socialite_worker', CASE r.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' ELSE 'TABLE' END, r.obj);
    END LOOP;
    FOR r IN SELECT p.oid::regprocedure AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'pgboss' AND pg_get_userbyid(p.proowner) <> 'socialite_worker'
    LOOP
      EXECUTE format('ALTER FUNCTION %s OWNER TO socialite_worker', r.fn);
    END LOOP;
    FOR r IN SELECT t.oid::regtype AS typ FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
              WHERE n.nspname = 'pgboss' AND t.typtype IN ('e','d') AND pg_get_userbyid(t.typowner) <> 'socialite_worker'
    LOOP
      EXECUTE format('ALTER TYPE %s OWNER TO socialite_worker', r.typ);
    END LOOP;
  END IF;
END $$;

-- DML for the app and worker on every current and future application table / sequence / function.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO socialite_app, socialite_worker;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO socialite_app, socialite_worker;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO socialite_app, socialite_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE socialite_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO socialite_app, socialite_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE socialite_migrator IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO socialite_app, socialite_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE socialite_migrator IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO socialite_app, socialite_worker;

-- Audit log: append-only for application roles (INSERT + SELECT). A database superuser can still rewrite it;
-- see docs/V2_THREAT_MODEL.md (no external immutable sink is configured).
-- (table statements are guarded: on a brand-new database this file runs before the migrations create the tables)
DO $$
BEGIN
  IF to_regclass('public.audit_events') IS NOT NULL THEN
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM socialite_app, socialite_worker';
  END IF;
  -- V3.1 Admin: the platform audit is append-only for the same roles.
  IF to_regclass('public.platform_audit_events') IS NOT NULL THEN
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON platform_audit_events FROM socialite_app, socialite_worker';
  END IF;
  -- Collaboration (027): task activity history is append-only for the same roles (cascades from task deletion run as owner).
  IF to_regclass('public.collab_task_events') IS NOT NULL THEN
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON collab_task_events FROM socialite_app, socialite_worker';
  END IF;
  -- V3.5 (028): case history (SLA evidence) is append-only for the same roles.
  IF to_regclass('public.care_case_events') IS NOT NULL THEN
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON care_case_events FROM socialite_app, socialite_worker';
  END IF;
END $$;
-- Migration bookkeeping is read-only outside the migrator.
DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON schema_migrations FROM socialite_app, socialite_worker';
  END IF;
END $$;
