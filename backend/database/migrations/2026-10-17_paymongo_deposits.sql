-- =====================================================================================================
-- PetHub: PayMongo appointment deposits (tables public.payments and public.appointments)
-- Prepared 2026-10-17. NOT APPLIED. Run in the Supabase SQL Editor only after explicit approval,
-- in a dev/test Supabase project first.
--
--   P1  payments: provider_checkout_session_id, provider_payment_id, expires_at (+ unique indexes),
--       receipt_email_sent_at (marks the "deposit payment confirmed" email as sent, so it goes out once).  Required.
--   P2  payments: at most one Pending checkout per appointment (partial unique index).             Required.
--   P3  appointments: deposit_required boolean NOT NULL DEFAULT false.                             Required.
--       Every existing appointment becomes false (exempt); the backend inserts true for bookings
--       made while PAYMENTS_ENABLED=true.
--   P4  row level security on payments with no policies (closes it to the anon key).              LATER (PART 3).
--
-- The backend also relies on these existing payments columns: id, appointment_id, user_id, amount, payment_method,
-- payment_status, paid_at, created_at. It sets id and created_at itself, so their defaults do not matter.
-- appointments.payment_status is left untouched and is not used; payment state comes from payments only.
-- No data is changed or deleted.
--
-- Order: PART 1 (read-only checks) -> PART 2 (one transaction) -> PART 2 check -> deploy backend with
--        PAYMENTS_ENABLED unset -> set PAYMONGO_* test keys -> PAYMENTS_ENABLED=true -> test checkout + webhook ->
--        PART 3 (separate approval) -> PART 3 check.
-- The SQL Editor shows only the last result of a script, so run each check query on its own.
-- =====================================================================================================


-- ---------------------------------------------------------------------------------
-- PART 1: PREFLIGHT (read-only)
-- ---------------------------------------------------------------------------------

-- 1a. Columns. Expected: the payments columns listed above exist; none of provider_checkout_session_id,
--     provider_payment_id, expires_at, receipt_email_sent_at or appointments.deposit_required exist yet.
--     If one of them already exists (any type), stop and report it: ADD COLUMN IF NOT EXISTS would skip it silently.
SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name IN ('payments', 'appointments')
ORDER BY table_name, ordinal_position;

-- 1b. Constraints. Stop and report if you see:
--     - a CHECK on payments.payment_status that would reject 'Pending', 'Paid', 'Expired', 'Failed' or 'Refunded';
--     - a plain UNIQUE on payments.appointment_id (it would block a new checkout after an expired one).
SELECT conrelid::regclass::text AS on_table, conname, contype, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid IN (to_regclass('public.payments'), to_regclass('public.appointments'))
ORDER BY on_table, conname;

-- 1c. Indexes. The three index names used in PART 2 must not exist yet.
SELECT indexrelid::regclass::text AS index_name, indisvalid, pg_get_indexdef(indexrelid) AS definition
FROM pg_index
WHERE indrelid IN (to_regclass('public.payments'), to_regclass('public.appointments'))
ORDER BY index_name;

-- 1d. Must return NO rows, or the one-pending-checkout index in PART 2 fails.
--     (Returns only appointment ids and counts.)
SELECT appointment_id, count(*) AS pending_rows
FROM public.payments
WHERE appointment_id IS NOT NULL AND payment_status = 'Pending'
GROUP BY appointment_id
HAVING count(*) > 1;

-- 1e. Existing payment rows by status (counts only). Rows that already exist were not created by PetHub's code;
--     the deposit logic only looks at payments of appointments with deposit_required = true, so they are left alone.
SELECT payment_status, count(*) AS n
FROM public.payments
GROUP BY payment_status
ORDER BY payment_status;


-- ---------------------------------------------------------------------------------
-- PART 2: P1 + P2 + P3 (one transaction)
-- ---------------------------------------------------------------------------------
BEGIN;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS provider_checkout_session_id text,
  ADD COLUMN IF NOT EXISTS provider_payment_id text,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS receipt_email_sent_at timestamptz;

-- NULLs stay allowed (older rows); a PayMongo session or payment can belong to only one PetHub row
CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_checkout_session_id_key
  ON public.payments (provider_checkout_session_id);
CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_payment_id_key
  ON public.payments (provider_payment_id);

-- One open checkout per appointment. Paid rows are deliberately not covered: a real payment must always be
-- recordable, even an unexpected second one (PetHub then shows it as "refund required").
CREATE UNIQUE INDEX IF NOT EXISTS payments_one_pending_per_appointment
  ON public.payments (appointment_id)
  WHERE appointment_id IS NOT NULL AND payment_status = 'Pending';

-- Existing appointments become false (exempt from the deposit)
ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS deposit_required boolean NOT NULL DEFAULT false;

COMMIT;

-- Lets the Supabase API see the new columns at once (it normally reloads on its own after DDL)
NOTIFY pgrst, 'reload schema';

-- PART 2 check (read-only). Expected 5 rows:
--   appointments.deposit_required boolean NO false
--   payments.expires_at / provider_checkout_session_id / provider_payment_id / receipt_email_sent_at, all nullable, no default
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND ((table_name = 'payments' AND column_name IN ('provider_checkout_session_id', 'provider_payment_id', 'expires_at', 'receipt_email_sent_at'))
    OR (table_name = 'appointments' AND column_name = 'deposit_required'))
ORDER BY table_name, column_name;


-- ---------------------------------------------------------------------------------
-- PART 3: P4 row level security on payments (LATER, separate approval)
-- ---------------------------------------------------------------------------------
-- The backend reads and writes payments only with SUPABASE_SERVICE_KEY, which bypasses RLS. With RLS on and
-- no policies, the anon and authenticated roles can no longer read or change payment rows through the Data API.
-- Before running: SUPABASE_SERVICE_KEY is set on Railway, and a test checkout + webhook worked after deploy.
-- Enabling RLS also activates any existing policies on payments: review them first (preflight review, query D2).
-- ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
--
-- PART 3 check (read-only): expect rls_enabled = true
-- SELECT relrowsecurity AS rls_enabled FROM pg_class WHERE oid = to_regclass('public.payments');


-- ---------------------------------------------------------------------------------
-- UNDO (only while no real PayMongo payments exist)
-- ---------------------------------------------------------------------------------
-- Turn PAYMENTS_ENABLED off first: while it is on, the backend reads these columns.
-- PART 3: ALTER TABLE public.payments DISABLE ROW LEVEL SECURITY;
-- PART 2:
--   ALTER TABLE public.appointments DROP COLUMN IF EXISTS deposit_required;
--   DROP INDEX IF EXISTS public.payments_one_pending_per_appointment;
--   DROP INDEX IF EXISTS public.payments_provider_payment_id_key;
--   DROP INDEX IF EXISTS public.payments_provider_checkout_session_id_key;
--   ALTER TABLE public.payments DROP COLUMN IF EXISTS receipt_email_sent_at,
--                               DROP COLUMN IF EXISTS expires_at,
--                               DROP COLUMN IF EXISTS provider_payment_id,
--                               DROP COLUMN IF EXISTS provider_checkout_session_id;
-- Once real payments exist, never drop these columns; switch PAYMENTS_ENABLED off instead.
