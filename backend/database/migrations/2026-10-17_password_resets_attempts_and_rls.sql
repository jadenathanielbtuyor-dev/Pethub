-- =====================================================================================================
-- PetHub: Forgot Password database changes (table public.password_resets only)
-- Prepared 2026-10-17. PARTIALLY APPLIED (verified 2026-10-23): D1 (attempts column and its CHECK) exists; the D1b
-- index does not; D2 (RLS) is not on. Do not run this file again: D1b is in 2026-10-23_reconcile_live_schema.sql and D2 in
-- 2026-10-20_rls_least_privilege.sql.
--
--   D1   attempts column: counts code checks (the backend allows 3).                Required before backend deploy.
--   D1b  one open (unused) code per user: parallel requests can't send two emails.  Required before backend deploy.
--   D2   row level security with no policies: closes the table to the anon key.     LATER, separately (PART 3).
--
-- public.users is not changed. No data is deleted. Nothing else in the app reads or writes password_resets.
--
-- Order: PART 1 (read-only checks) -> PART 2 (D1 + D1b, one transaction) -> PART 2 checks -> deploy backend ->
--        confirm a real reset works -> PART 3 (D2) -> PART 3 checks.
-- The SQL Editor shows only the last result of a script, so run each check query on its own.
-- =====================================================================================================


-- ---------------------------------------------------------------------------------
-- PART 1: PREFLIGHT (read-only)
-- ---------------------------------------------------------------------------------

-- 1a. Columns. Expected: no "attempts" row yet; "id" has a uuid default (e.g. gen_random_uuid())
--     and "created_at" defaults to now(). The backend relies on both defaults when it inserts a code.
--     If either column_default is empty, stop and report it before continuing.
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'password_resets'
ORDER BY ordinal_position;

-- 1b. Users with more than one open (unused) code. Must return NO rows.
--     If it returns rows, do not run PART 2 (D1b would fail anyway, and the transaction would change nothing).
SELECT user_id, count(*) AS open_codes
FROM public.password_resets
WHERE used_at IS NULL
GROUP BY user_id
HAVING count(*) > 1;


-- ---------------------------------------------------------------------------------
-- PART 2: D1 + D1b (one transaction: both are applied, or neither)
-- ---------------------------------------------------------------------------------
BEGIN;

-- D1: existing rows (currently none) get attempts = 0. A constant default does not rewrite the table.
ALTER TABLE public.password_resets
ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0
CHECK (attempts >= 0);

-- D1b: at most one row per user with used_at IS NULL. A request that loses the race gets error 23505,
-- which the backend treats as "cooldown active" and sends no email.
CREATE UNIQUE INDEX IF NOT EXISTS password_resets_one_open_code_per_user
ON public.password_resets (user_id)
WHERE used_at IS NULL;

COMMIT;

-- PART 2 checks (read-only)

-- 2a. Expect one row: attempts | integer | NO | 0
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'password_resets' AND column_name = 'attempts';

-- 2b. Expect: password_resets_pkey, password_resets_user_id_fkey, a CHECK ((attempts >= 0)) constraint, and the index
--     CREATE UNIQUE INDEX password_resets_one_open_code_per_user ... USING btree (user_id) WHERE (used_at IS NULL)
SELECT 'constraint' AS kind, conname AS name, pg_get_constraintdef(oid) AS definition
FROM pg_constraint WHERE conrelid = 'public.password_resets'::regclass
UNION ALL
SELECT 'index', indexname, indexdef
FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'password_resets';


-- ---------------------------------------------------------------------------------
-- PART 3: D2 (separate approval). Commented out so it can't run by accident with the rest of this file.
-- Run it ONLY after:
--   1. SUPABASE_SERVICE_KEY is set on Railway (the service_role / secret key, not the anon key),
--   2. the backend with config/supabaseAdmin.js is deployed, and
--   3. a real forgot-password request + reset has worked in production.
-- Every password_resets query in the backend goes through the service-role client, which bypasses RLS,
-- so D2 does not affect the feature. With no policies, the anon and authenticated roles can no longer
-- read or change reset rows through the Supabase API.
-- ---------------------------------------------------------------------------------

-- ALTER TABLE public.password_resets ENABLE ROW LEVEL SECURITY;

-- PART 3 checks (read-only)
-- 3a. Expect rls_enabled = true and policies = 0
-- SELECT c.relrowsecurity AS rls_enabled,
--        (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'password_resets') AS policies
-- FROM pg_class c WHERE c.oid = 'public.password_resets'::regclass;
-- 3b. Expect service_role = true (it bypasses RLS), anon = false, authenticated = false
-- SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role');


-- ---------------------------------------------------------------------------------
-- UNDO (only if needed; not part of the migration)
-- ---------------------------------------------------------------------------------
-- D2:  ALTER TABLE public.password_resets DISABLE ROW LEVEL SECURITY;
-- D1b: DROP INDEX IF EXISTS public.password_resets_one_open_code_per_user;
--      (the backend still works without it, but parallel requests could send more than one email)
-- D1:  ALTER TABLE public.password_resets DROP COLUMN IF EXISTS attempts;
--      (only while the forgot-password backend is NOT deployed; it reads and writes this column)
