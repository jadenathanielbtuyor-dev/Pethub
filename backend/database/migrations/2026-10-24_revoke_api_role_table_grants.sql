-- =====================================================================================================
-- PetHub: remove the table privileges the public API roles still hold on the 14 original tables
-- Prepared 2026-10-24 (read-only review). NOT APPLIED. Run once, as ONE script (it is one transaction).
--
-- Live state inspected 2026-10-24 through the Supabase MCP:
--   * RLS is ON for all 17 public tables, with 0 policies, so anon/authenticated already see and change no rows.
--   * But on the 14 original tables anon and authenticated still hold arwdDxtm = SELECT, INSERT, UPDATE, DELETE,
--     TRUNCATE, REFERENCES, TRIGGER and MAINTAIN (PostgreSQL 17). TRUNCATE and MAINTAIN are not limited by RLS.
--     PostgREST and pg_graphql cannot issue them, but nothing in PetHub needs any of these grants.
--   * service_role holds its own explicit arwdDxtm entry on every table and is not a member of anon or authenticated,
--     so this REVOKE does not touch the backend's access. No PUBLIC, column-level, sequence or view grants exist.
--   * The 3 tables added on 2026-10-23 and the 3 appointment functions already grant nothing to the API roles.
--
-- Effect: the public (publishable/anon) key gets "permission denied" (HTTP 401, code 42501) instead of an empty
-- list on these tables. The PetHub backend uses the service role key and is unaffected. No row, column, policy,
-- function or RLS setting changes.
-- =====================================================================================================

BEGIN;

-- PART 0: PREFLIGHT. Any difference from the inspected state stops everything (nothing changes).
DO $preflight$
DECLARE
  problems text[] := ARRAY[]::text[];
  tbl regclass;
BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') <> 0 THEN
    problems := problems || 'public has row level security policies: review them before revoking'::text;
  END IF;
  IF pg_has_role('service_role', 'anon', 'MEMBER') OR pg_has_role('service_role', 'authenticated', 'MEMBER') THEN
    problems := problems || 'service_role inherits from an API role'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm', 'f')) THEN
    problems := problems || 'public contains views or foreign tables: review their grants first'::text;
  END IF;

  FOR tbl IN SELECT to_regclass('public.' || name) FROM unnest(ARRAY[
    'users', 'email_verifications', 'password_resets', 'pets', 'appointments', 'appointment_status_history',
    'medical_records', 'activity_logs', 'contact_messages', 'notifications', 'email_logs', 'reminder_logs',
    'system_settings', 'payments']) AS name
  LOOP
    IF tbl IS NULL THEN
      problems := problems || 'one of the 14 PetHub tables is missing'::text;
      CONTINUE;
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = tbl) THEN
      problems := problems || format('%s: row level security is off', tbl);
    END IF;
    IF NOT (has_table_privilege('service_role', tbl, 'SELECT') AND has_table_privilege('service_role', tbl, 'INSERT')
            AND has_table_privilege('service_role', tbl, 'UPDATE') AND has_table_privilege('service_role', tbl, 'DELETE')) THEN
      problems := problems || format('%s: service_role lacks SELECT/INSERT/UPDATE/DELETE', tbl);
    END IF;
  END LOOP;

  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'PetHub grant cleanup stopped, nothing was changed: %', array_to_string(problems, '; ');
  END IF;
END
$preflight$;

-- PART 1: the change
REVOKE ALL PRIVILEGES ON TABLE
  public.users, public.email_verifications, public.password_resets, public.pets, public.appointments,
  public.appointment_status_history, public.medical_records, public.activity_logs, public.contact_messages,
  public.notifications, public.email_logs, public.reminder_logs, public.system_settings, public.payments
FROM PUBLIC, anon, authenticated;

-- PART Z: POST-CHECKS (inside the transaction; any failure rolls everything back)
DO $postcheck$
DECLARE
  problems text[] := ARRAY[]::text[];
  tbl regclass;
  api_role text;
  privilege text;
BEGIN
  FOR tbl IN SELECT c.oid::regclass FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  LOOP
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      FOREACH privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] LOOP
        IF has_table_privilege(api_role, tbl, privilege) THEN
          problems := problems || format('%s: %s still has %s', tbl, api_role, privilege);
        END IF;
      END LOOP;
      IF has_any_column_privilege(api_role, tbl, 'SELECT, INSERT, UPDATE, REFERENCES') THEN
        problems := problems || format('%s: %s still has a column privilege', tbl, api_role);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) AS acl WHERE c.oid = tbl AND acl.grantee = 0) THEN
      problems := problems || format('%s: PUBLIC still has a privilege', tbl);
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = tbl) THEN
      problems := problems || format('%s: row level security is off', tbl);
    END IF;
    IF NOT (has_table_privilege('service_role', tbl, 'SELECT') AND has_table_privilege('service_role', tbl, 'INSERT')
            AND has_table_privilege('service_role', tbl, 'UPDATE') AND has_table_privilege('service_role', tbl, 'DELETE')) THEN
      problems := problems || format('%s: service_role lost access', tbl);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
             AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))) THEN
    problems := problems || 'an API role can execute a public function'::text;
  END IF;

  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'PetHub grant cleanup post-check failed, nothing was changed: %', array_to_string(problems, '; ');
  END IF;
END
$postcheck$;

COMMIT;

-- Lets the Supabase API (PostgREST) pick up the new privileges at once
NOTIFY pgrst, 'reload schema';


-- ---------------------------------------------------------------------------------
-- ROLLBACK (not part of the change). Restores exactly the 2026-10-24 snapshot (anon/authenticated = arwdDxtm, which
-- is ALL PRIVILEGES on PostgreSQL 17, granted by postgres). It re-opens TRUNCATE/MAINTAIN to the API roles; use only
-- if a reviewed reason requires it.
--   GRANT ALL PRIVILEGES ON TABLE
--     public.users, public.email_verifications, public.password_resets, public.pets, public.appointments,
--     public.appointment_status_history, public.medical_records, public.activity_logs, public.contact_messages,
--     public.notifications, public.email_logs, public.reminder_logs, public.system_settings, public.payments
--   TO anon, authenticated;
--   NOTIFY pgrst, 'reload schema';
