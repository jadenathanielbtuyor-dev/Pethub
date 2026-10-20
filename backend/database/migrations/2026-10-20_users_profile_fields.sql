-- =====================================================================================================
-- PetHub: optional profile details on public.users (registration page + user dashboard "Your details")
-- Prepared 2026-10-20. NOT APPLIED. Run in the Supabase SQL Editor only after explicit approval.
--
--   P1  seven new NULLABLE columns: date_of_birth, gender, address_line, barangay, city_municipality, province,
--       postal_code. Required BEFORE the backend that saves them is deployed.
--
-- users.phone_number already exists (text, nullable) and is reused for the contact number; it is not altered.
-- Purely additive: no existing column is renamed, retyped, dropped or repurposed; no row is updated or deleted;
-- no other table, constraint, index, trigger, policy, grant or RLS setting is changed. Existing accounts keep
-- NULL in every new column. Adding a nullable column without a default does not rewrite the table.
--
-- No CHECK constraints: the backend validates every value (validators/authValidator.js), and a second copy of
-- those rules in the database would have to change in step with the code.
--
-- Order: PART 1 (read-only checks) -> PART 2 (one transaction) -> PART 3 (read-only checks) -> deploy backend ->
--        deploy frontend.
-- The SQL Editor shows only the last result of a script, so run each check query on its own.
-- =====================================================================================================


-- ---------------------------------------------------------------------------------
-- PART 1: PREFLIGHT (read-only)
-- ---------------------------------------------------------------------------------

-- 1a. Columns of public.users. Expected (verified 2026-10-20 through the PostgREST schema): id, fullname, email,
--     password, role, created_at, is_verified, phone_number, profile_image, last_login_at, status, deleted_at.
--     None of the seven PART 2 columns should be listed yet, and phone_number should be "text", nullable "YES".
--     If any PART 2 column already exists with a different data_type, stop and report it (IF NOT EXISTS would
--     silently keep the existing type).
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'users'
ORDER BY ordinal_position;


-- ---------------------------------------------------------------------------------
-- PART 2: P1 (one transaction: all seven columns are added, or none)
-- ---------------------------------------------------------------------------------
BEGIN;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS date_of_birth date,
  ADD COLUMN IF NOT EXISTS gender text,
  ADD COLUMN IF NOT EXISTS address_line text,
  ADD COLUMN IF NOT EXISTS barangay text,
  ADD COLUMN IF NOT EXISTS city_municipality text,
  ADD COLUMN IF NOT EXISTS province text,
  ADD COLUMN IF NOT EXISTS postal_code text;

COMMENT ON COLUMN public.users.date_of_birth IS 'Optional. Customer date of birth (YYYY-MM-DD), not before 1900 and not in the future.';
COMMENT ON COLUMN public.users.gender IS 'Optional. One of: Female, Male, Non-binary, Other, Prefer not to say.';
COMMENT ON COLUMN public.users.address_line IS 'Optional. House/Unit/Street, up to 150 characters.';
COMMENT ON COLUMN public.users.barangay IS 'Optional. Up to 100 characters.';
COMMENT ON COLUMN public.users.city_municipality IS 'Optional. Up to 100 characters.';
COMMENT ON COLUMN public.users.province IS 'Optional. Up to 100 characters.';
COMMENT ON COLUMN public.users.postal_code IS 'Optional. 4-digit Philippine postal code.';

COMMIT;

-- Supabase reloads the API schema after DDL automatically; this makes PostgREST pick up the new columns at once.
NOTIFY pgrst, 'reload schema';


-- ---------------------------------------------------------------------------------
-- PART 3: CHECKS (read-only)
-- ---------------------------------------------------------------------------------

-- 3a. Expected: 7 rows, every one is_nullable = YES and column_default empty.
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'users'
  AND column_name IN ('date_of_birth', 'gender', 'address_line', 'barangay', 'city_municipality', 'province', 'postal_code')
ORDER BY column_name;

-- 3b. Existing accounts are unchanged: users_total is the same as before PART 2, and with_profile_values is 0.
SELECT count(*) AS users_total,
       count(*) FILTER (WHERE date_of_birth IS NOT NULL OR gender IS NOT NULL OR address_line IS NOT NULL
                           OR barangay IS NOT NULL OR city_municipality IS NOT NULL OR province IS NOT NULL
                           OR postal_code IS NOT NULL) AS with_profile_values
FROM public.users;


-- ---------------------------------------------------------------------------------
-- ROLLBACK (only while no deployed backend uses these columns; it deletes whatever was saved in them)
-- ---------------------------------------------------------------------------------
-- BEGIN;
-- ALTER TABLE public.users
--   DROP COLUMN IF EXISTS date_of_birth,
--   DROP COLUMN IF EXISTS gender,
--   DROP COLUMN IF EXISTS address_line,
--   DROP COLUMN IF EXISTS barangay,
--   DROP COLUMN IF EXISTS city_municipality,
--   DROP COLUMN IF EXISTS province,
--   DROP COLUMN IF EXISTS postal_code;
-- COMMIT;
-- NOTIFY pgrst, 'reload schema';


-- ---------------------------------------------------------------------------------
-- OPTIONAL, SEPARATE DECISION (not needed for the profile fields): unique email addresses
-- ---------------------------------------------------------------------------------
-- The backend refuses a second registration for the same email, and runs simultaneous registrations for one
-- email one at a time inside a backend process. Whether the database itself also enforces unique emails could
-- not be verified (the PostgREST schema does not show indexes). To check (read-only):
--   SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'users';
-- If no unique index covers email, first look for existing duplicates (must return no rows):
--   SELECT lower(email) AS email, count(*) FROM public.users GROUP BY lower(email) HAVING count(*) > 1;
-- and only then, if approved:
--   CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON public.users (lower(email));
-- The backend already answers the resulting duplicate-key error (23505) with "Email already registered".
