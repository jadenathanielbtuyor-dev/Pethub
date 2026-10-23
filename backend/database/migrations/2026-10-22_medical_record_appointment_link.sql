-- PetHub: persist the optional relationship between one completed appointment and one official medical record.
-- Prepared 2026-10-22. NOT APPLIED (verified 2026-10-23; medical_records had 0 rows). Included unchanged in
-- 2026-10-23_reconcile_live_schema.sql: run that file instead of this one.
--
-- Current application behavior permits at most one medical record for a completed appointment, but it does not
-- persist appointment_id. The application currently tries to reconstruct that link from an activity-log action.
-- This migration makes future links explicit and lets PostgreSQL enforce one record per linked appointment.
-- Existing rows remain NULL. Do not backfill them from names, dates, or activity logs without verified evidence.
-- Records for walk-ins / visits without an appointment remain valid with appointment_id NULL.
--
-- Preflight (read-only; run separately and save results):
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'medical_records'
--   ORDER BY ordinal_position;
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint WHERE conrelid = 'public.medical_records'::regclass;
--   SELECT indexname, indexdef
--   FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'medical_records';
-- Stop if appointment_id or an equivalent FK/index already exists; inspect its type and semantics first.
-- Confirm appointments.id and medical_records.id/pet_id are UUIDs and the backend uses a service-role key.
--
-- Application order: deploy this migration, verify it, then deploy code that writes and reads this column.
-- No historical associations are inserted by this migration.

BEGIN;

ALTER TABLE public.medical_records
  ADD COLUMN appointment_id uuid;

ALTER TABLE public.medical_records
  ADD CONSTRAINT medical_records_appointment_id_fkey
  FOREIGN KEY (appointment_id) REFERENCES public.appointments(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX medical_records_one_per_appointment_key
  ON public.medical_records (appointment_id)
  WHERE appointment_id IS NOT NULL;

COMMENT ON COLUMN public.medical_records.appointment_id IS
  'Optional explicit link to the completed appointment that produced this official record. Existing historical rows remain unlinked until an association is independently verified.';

COMMIT;
NOTIFY pgrst, 'reload schema';

-- Post-migration verification (read-only; expect appointment_id uuid nullable, the FK, and the partial unique index):
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'medical_records' AND column_name = 'appointment_id';
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint WHERE conrelid = 'public.medical_records'::regclass
--     AND conname = 'medical_records_appointment_id_fkey';
--   SELECT indexname, indexdef
--   FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'medical_records'
--     AND indexname = 'medical_records_one_per_appointment_key';
--   SELECT count(*) AS historical_unlinked_records
--   FROM public.medical_records WHERE appointment_id IS NULL;
-- Verify API owner/admin flows in staging and attempt a duplicate association in a transaction that is rolled back.
-- Verify approval does not create a medical record and a Pending/Approved appointment cannot be linked by the API.

-- Rollback: prefer rolling back API code while retaining this additive column and index. Dropping them would lose
-- all appointment links written after deployment. Only if no linked records exist, or after exporting/preserving all
-- appointment_id values, may an approved operator run:
--   BEGIN;
--   DROP INDEX IF EXISTS public.medical_records_one_per_appointment_key;
--   ALTER TABLE public.medical_records DROP CONSTRAINT IF EXISTS medical_records_appointment_id_fkey;
--   ALTER TABLE public.medical_records DROP COLUMN IF EXISTS appointment_id;
--   COMMIT;
--   NOTIFY pgrst, 'reload schema';
