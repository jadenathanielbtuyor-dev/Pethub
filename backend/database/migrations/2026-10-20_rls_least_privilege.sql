-- =====================================================================================================
-- PetHub: close the database to the public (publishable / anon) API key
-- Prepared 2026-10-20. NOT APPLIED. Run in the Supabase SQL Editor only after explicit approval.
--
-- Why: on 2026-10-20 a count-only check (no rows read) showed the publishable key could read EVERY public table,
-- with the same row counts as the service role key: users (including the password column), email_verifications
-- (including codes), appointments, pets, activity_logs, payments and the rest. Whether that comes from row level
-- security being disabled or from permissive policies/grants could not be seen through the API; PART 1 shows it.
--
-- The browser never talks to Supabase: every query goes through the PetHub backend. So the public key needs no access
-- at all, and the fix is: RLS ON for every table, with no policies for anon/authenticated. The backend keeps working
-- because it uses the service role key, which bypasses RLS (config/env.js prefers SUPABASE_SERVICE_KEY).
--
-- This file supersedes PART 3 of 2026-10-17_password_resets_attempts_and_rls.sql (password_resets is included here).
-- No column, row, function or credential is changed. Nothing is deleted except, OPTIONALLY (PART 3b), policies that
-- PART 1 lists, after you have saved that list.
--
-- ORDER (each step only after the previous one is confirmed):
--   0. Railway: SUPABASE_SERVICE_KEY holds the service role key (Supabase -> Project Settings -> API keys,
--      "service_role" / "secret"). Never put it in the frontend.
--   1. Deploy the backend from this branch. Its startup log must show
--        supabase.client_key { variable: 'SUPABASE_SERVICE_KEY', role: 'service_role' }
--      (a WARN line with role 'anon' means the service key is missing: STOP, step 3 would break the app).
--   2. Smoke test production: log in, open the dashboard, book or view an appointment, open the admin dashboard.
--   3. PART 1 here (read-only) and save its output.
--   4. PART 2 (one transaction).
--   5. PART 3a; PART 3b only if PART 1b listed policies for anon, authenticated or public.
--   6. PART 4 checks, then repeat the smoke test from step 2.
-- The SQL Editor shows only the last result of a script, so run each check query on its own.
-- =====================================================================================================


-- ---------------------------------------------------------------------------------
-- PART 1: DIAGNOSE (read-only). Save every result before continuing.
-- ---------------------------------------------------------------------------------

-- 1a. RLS per table. relrowsecurity = false means RLS is OFF for that table (the likely cause).
SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
ORDER BY c.relname;

-- 1b. Existing policies. Any row whose roles include anon, authenticated or public (and whose qual is "true" or
--     missing) lets the public key in even with RLS ON.
SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;

-- 1c. Table privileges of the API roles (Supabase grants these by default; with RLS ON and no policy they are inert).
SELECT table_name, grantee, string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND grantee IN ('PUBLIC', 'anon', 'authenticated')
GROUP BY table_name, grantee
ORDER BY table_name, grantee;

-- 1c.1. Column grants on sensitive tables. RLS controls rows; this lists direct grants that could expose a sensitive
-- column if a row policy is permissive or RLS is later disabled. PUBLIC is included explicitly.
SELECT table_name, column_name, grantee, privilege_type
FROM information_schema.column_privileges
WHERE table_schema = 'public'
  AND table_name IN ('users', 'email_verifications', 'password_resets')
  AND grantee IN ('PUBLIC', 'anon', 'authenticated')
ORDER BY table_name, column_name, grantee;

-- 1c.2. Effective SELECT access to sensitive columns (expect false after hardening).
SELECT sensitive.role_name, sensitive.table_name, sensitive.column_name,
       CASE WHEN columns.column_name IS NULL THEN NULL
            ELSE has_column_privilege(sensitive.role_name, format('public.%I', sensitive.table_name), sensitive.column_name, 'SELECT')
       END AS can_select
FROM (VALUES
  ('anon', 'users', 'password'),
  ('authenticated', 'users', 'password'),
  ('anon', 'email_verifications', 'verification_code'),
  ('authenticated', 'email_verifications', 'verification_code'),
  ('anon', 'password_resets', 'reset_token'),
  ('authenticated', 'password_resets', 'reset_token')
) AS sensitive(role_name, table_name, column_name)
LEFT JOIN information_schema.columns
  ON columns.table_schema = 'public'
  AND columns.table_name = sensitive.table_name
  AND columns.column_name = sensitive.column_name;

-- 1d. Who bypasses RLS. Expected: service_role = true, anon = false, authenticated = false.
SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role');

-- 1e. Functions in public that the API could call (RPC). PetHub's backend calls none. A SECURITY DEFINER function
--     (security_definer = true) runs with its owner's rights and is NOT limited by RLS: report any before continuing.
SELECT p.proname AS function_name, p.prosecdef AS security_definer
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
ORDER BY p.proname;


-- ---------------------------------------------------------------------------------
-- PART 2: RLS ON for every PetHub table (one transaction: all fourteen, or none).
-- A table name that does not exist stops the whole transaction and changes nothing; report it.
-- ---------------------------------------------------------------------------------
BEGIN;

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.password_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointment_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.medical_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reminder_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

COMMIT;


-- ---------------------------------------------------------------------------------
-- PART 3a: check (read-only). Expect rls_enabled = true for all fourteen tables.
-- ---------------------------------------------------------------------------------
SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
ORDER BY c.relname;

-- PART 3b: ONLY if PART 1b listed policies for anon, authenticated or public. Write one line per policy from your saved
-- PART 1b output (it is also your way back: each policy can be recreated from that output), for example:
--   DROP POLICY IF EXISTS "Enable read access for all users" ON public.users;
-- PetHub needs no policy at all: the backend's service role bypasses RLS.


-- ---------------------------------------------------------------------------------
-- PART 4: CHECKS after PART 2/3
-- ---------------------------------------------------------------------------------
-- 4a. In the SQL Editor (read-only): expect 0 rows.
SELECT tablename, policyname, roles FROM pg_policies
WHERE schemaname = 'public' AND roles && ARRAY['anon', 'authenticated', 'public']::name[];

-- 4b. Outside the SQL Editor, with the PUBLISHABLE key only (never paste keys into shared documents):
--       GET https://<project>.supabase.co/rest/v1/users?select=id   headers: apikey + Authorization: Bearer <publishable>
--     Expect an empty list [] (RLS hides every row). Repeat for appointments and email_verifications.
-- 4c. Repeat the production smoke test: log in, dashboard, appointments, admin dashboard, forgot password.


-- ---------------------------------------------------------------------------------
-- OPTIONAL, SEPARATE DECISION (defence in depth, not needed for the fix above)
-- ---------------------------------------------------------------------------------
-- With RLS ON and no policies the API roles already see nothing. Revoking their table privileges as well means a
-- policy added by mistake later still could not expose data. Include PUBLIC, which is inherited by API roles:
--   REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, anon, authenticated;
-- Restore privileges only from a reviewed/saved PART 1c result. Do not use a blanket GRANT to roll this back.


-- ---------------------------------------------------------------------------------
-- ROLLBACK (if the backend stops working after PART 2: it is then NOT using the service role key)
-- ---------------------------------------------------------------------------------
-- WARNING: Do not disable RLS as an application rollback on a public project. That reopens the exposure this migration
-- is intended to stop. First fix the backend's SUPABASE_SERVICE_KEY and verify the role without printing the key. If
-- that is impossible, use the reviewed policy/grant snapshot and an approved recovery plan; do not run the block below
-- against production as-is.
-- BEGIN;
-- ALTER TABLE public.users DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.email_verifications DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.password_resets DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.pets DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.appointments DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.appointment_status_history DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.medical_records DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.activity_logs DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.contact_messages DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.notifications DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.email_logs DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.reminder_logs DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.system_settings DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.payments DISABLE ROW LEVEL SECURITY;
-- COMMIT;
-- Then fix SUPABASE_SERVICE_KEY on Railway, redeploy, confirm the startup log, and try PART 2 again.
