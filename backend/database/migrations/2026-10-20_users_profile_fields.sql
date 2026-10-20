-- =====================================================================================================
-- PetHub: personal and contact details on public.users (registration page + user dashboard "Your details")
-- Prepared 2026-10-20, revised 2026-10-20 (details now REQUIRED for new accounts). NOT APPLIED.
-- Run in the Supabase SQL Editor only after explicit approval.
--
--   P1  seven new NULLABLE columns: date_of_birth, gender, address_line, barangay, city_municipality, province,
--       postal_code, each with a CHECK constraint that accepts NULL or a value the backend would accept.
--       Required BEFORE the backend that saves them is deployed: until then that backend refuses every registration
--       (HTTP 503, nothing saved) because the details are part of the same insert.
--
-- Why nullable although the details are required: the accounts that already exist were created without them. They
-- keep NULL until their owner completes the details from the dashboard (PUT /auth/profile); no value is invented for
-- them. The backend requires every detail for each new registration and each profile update
-- (validators/authValidator.js, constants/userProfile.js).
--
-- users.phone_number already exists (text, nullable) and is reused for the contact number; it is not altered and gets
-- no constraint here, because values saved before this change were never checked.
-- Purely additive: no existing column is renamed, retyped, dropped or repurposed; no row is updated or deleted;
-- no other table, index, trigger, policy, grant or RLS setting is changed (RLS: 2026-10-20_rls_least_privilege.sql).
-- Adding nullable columns without a default does not rewrite the table, and the constraints are checked against
-- columns that are still empty, so PART 2 is quick.
--
-- The CHECK constraints repeat the backend's rules (dates from 1900, the five gender options, the length limits and
-- the 4-digit postal code). If a rule changes in constants/userProfile.js, change its constraint in the same release.
-- "Not in the future" is checked by the backend only (a CHECK may not depend on today's date).
--
-- Order: PART 1 (read-only checks) -> PART 2 (one transaction) -> PART 3 (read-only checks) -> deploy backend ->
--        deploy frontend.
-- PART 2 runs once. Running it again stops at the first ADD CONSTRAINT ("already exists") and, being one
-- transaction, changes nothing.
-- The SQL Editor shows only the last result of a script, so run each check query on its own.
-- =====================================================================================================


-- ---------------------------------------------------------------------------------
-- PART 1: PREFLIGHT (read-only)
-- ---------------------------------------------------------------------------------

-- 1a. Columns of public.users. Expected (verified again 2026-10-20 through the PostgREST schema): id, fullname,
--     email, password, role, created_at, is_verified, phone_number, profile_image, last_login_at, status, deleted_at.
--     None of the seven PART 2 columns should be listed yet, and phone_number should be "text", nullable "YES".
--     If any PART 2 column already exists, stop and report it (IF NOT EXISTS would silently keep its existing type).
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'users'
ORDER BY ordinal_position;

-- 1b. Constraints already on public.users. None of the PART 2 constraint names should be listed.
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.users'::regclass
ORDER BY conname;


-- ---------------------------------------------------------------------------------
-- PART 2: P1 (one transaction: all seven columns and their constraints are added, or none)
-- ---------------------------------------------------------------------------------
BEGIN;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS date_of_birth date,
  ADD COLUMN IF NOT EXISTS gender text,
  ADD COLUMN IF NOT EXISTS address_line text,
  ADD COLUMN IF NOT EXISTS barangay text,
  ADD COLUMN IF NOT EXISTS city_municipality text,
  ADD COLUMN IF NOT EXISTS province text,
  ADD COLUMN IF NOT EXISTS postal_code text,
  ADD CONSTRAINT users_date_of_birth_range CHECK (date_of_birth IS NULL OR date_of_birth >= DATE '1900-01-01'),
  ADD CONSTRAINT users_gender_option CHECK (gender IS NULL OR gender IN ('Female', 'Male', 'Non-binary', 'Other', 'Prefer not to say')),
  ADD CONSTRAINT users_address_line_length CHECK (address_line IS NULL OR char_length(address_line) BETWEEN 1 AND 150),
  ADD CONSTRAINT users_barangay_length CHECK (barangay IS NULL OR char_length(barangay) BETWEEN 1 AND 100),
  ADD CONSTRAINT users_city_municipality_length CHECK (city_municipality IS NULL OR char_length(city_municipality) BETWEEN 1 AND 100),
  ADD CONSTRAINT users_province_length CHECK (province IS NULL OR char_length(province) BETWEEN 1 AND 100),
  ADD CONSTRAINT users_postal_code_format CHECK (postal_code IS NULL OR postal_code ~ '^[0-9]{4}$');

COMMENT ON COLUMN public.users.date_of_birth IS 'Required for accounts created after 2026-10-20 (NULL for earlier accounts until completed). YYYY-MM-DD, from 1900, not in the future.';
COMMENT ON COLUMN public.users.gender IS 'Required for new accounts (NULL for earlier accounts until completed). One of: Female, Male, Non-binary, Other, Prefer not to say.';
COMMENT ON COLUMN public.users.address_line IS 'Required for new accounts (NULL for earlier accounts until completed). House/unit number and street, up to 150 characters.';
COMMENT ON COLUMN public.users.barangay IS 'Required for new accounts (NULL for earlier accounts until completed). Up to 100 characters.';
COMMENT ON COLUMN public.users.city_municipality IS 'Required for new accounts (NULL for earlier accounts until completed). Up to 100 characters.';
COMMENT ON COLUMN public.users.province IS 'Required for new accounts (NULL for earlier accounts until completed). Up to 100 characters.';
COMMENT ON COLUMN public.users.postal_code IS 'Required for new accounts (NULL for earlier accounts until completed). 4-digit Philippine postal code.';

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

-- 3b. Expected: the 7 constraints users_address_line_length, users_barangay_length, users_city_municipality_length,
--     users_date_of_birth_range, users_gender_option, users_postal_code_format, users_province_length.
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.users'::regclass AND conname LIKE 'users\_%' ESCAPE '\'
  AND contype = 'c'
ORDER BY conname;

-- 3c. Existing accounts are unchanged: users_total is the same as before PART 2, and with_profile_values is 0.
SELECT count(*) AS users_total,
       count(*) FILTER (WHERE date_of_birth IS NOT NULL OR gender IS NOT NULL OR address_line IS NOT NULL
                           OR barangay IS NOT NULL OR city_municipality IS NOT NULL OR province IS NOT NULL
                           OR postal_code IS NOT NULL) AS with_profile_values
FROM public.users;


-- ---------------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------------
-- Only while NO deployed backend uses these columns (otherwise every registration and profile update fails), and
-- knowing that it DELETES every detail customers have saved in them since PART 2 (back up first, e.g.
-- SELECT id, date_of_birth, gender, address_line, barangay, city_municipality, province, postal_code FROM public.users;
-- and keep that export private). Dropping a column also drops its constraint.
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
