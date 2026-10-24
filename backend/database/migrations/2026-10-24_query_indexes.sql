-- =====================================================================================================
-- PetHub: indexes for the foreign-key columns the backend filters on
-- Prepared 2026-10-24 from the repositories' actual filters (backend/repositories/*.js). Run once, as ONE script.
--
-- Each index matches a query the application makes:
--   pets (user_id)                         My Pets, ownership checks          petsRepository: .eq('user_id')
--   appointments (user_id)                 owner appointments, cancellation   appointmentsRepository: .eq('user_id')
--   appointments (pet_id)                  pet history, delete guard          appointmentsRepository: .eq('pet_id')
--   appointments (appointment_date)        schedule by date and the overlap checks in create_appointment_if_available /
--                                          update_appointment_status_if_available (appointment_date BETWEEN d-1 AND d+1)
--   medical_records (pet_id)               health records, pet history        medicalRecordsRepository: .in/.eq('pet_id')
--   email_verifications (user_id)          verification and resend            emailVerificationsRepository: .eq('user_id')
--   activity_logs (user_id, created_at)    an owner's activity, newest first  activityLogsRepository: .eq('user_id').order
--   activity_logs (created_at)             the admin activity log, newest first
-- They also cover the foreign keys pets_user_fk, appointments_user_fk, appointments_pet_fk, medical_records_pet_fk,
-- email_verifications_user_fk and activity_logs_user_fk (Supabase advisor "unindexed foreign keys").
-- Additive only: no row, column or constraint changes. With today's row counts PostgreSQL still scans the tables; the
-- indexes keep these queries fast as the clinic's data grows.
-- =====================================================================================================

BEGIN;

DO $preflight$
DECLARE
  existing text[];
BEGIN
  SELECT array_agg(indexname) INTO existing FROM pg_indexes
  WHERE schemaname = 'public' AND indexname IN ('pets_user_id_idx', 'appointments_user_id_idx', 'appointments_pet_id_idx',
    'appointments_appointment_date_idx', 'medical_records_pet_id_idx', 'email_verifications_user_id_idx',
    'activity_logs_user_id_created_at_idx', 'activity_logs_created_at_idx');
  IF existing IS NOT NULL THEN
    RAISE EXCEPTION 'PetHub indexes stopped, nothing was changed: already present: %', array_to_string(existing, ', ');
  END IF;
END
$preflight$;

CREATE INDEX pets_user_id_idx ON public.pets (user_id);
CREATE INDEX appointments_user_id_idx ON public.appointments (user_id);
CREATE INDEX appointments_pet_id_idx ON public.appointments (pet_id);
CREATE INDEX appointments_appointment_date_idx ON public.appointments (appointment_date);
CREATE INDEX medical_records_pet_id_idx ON public.medical_records (pet_id);
CREATE INDEX email_verifications_user_id_idx ON public.email_verifications (user_id);
CREATE INDEX activity_logs_user_id_created_at_idx ON public.activity_logs (user_id, created_at DESC);
CREATE INDEX activity_logs_created_at_idx ON public.activity_logs (created_at DESC);

DO $postcheck$
BEGIN
  IF (SELECT count(*) FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
      WHERE i.relname IN ('pets_user_id_idx', 'appointments_user_id_idx', 'appointments_pet_id_idx',
        'appointments_appointment_date_idx', 'medical_records_pet_id_idx', 'email_verifications_user_id_idx',
        'activity_logs_user_id_created_at_idx', 'activity_logs_created_at_idx')
      AND x.indisvalid AND x.indisready) <> 8 THEN
    RAISE EXCEPTION 'PetHub indexes post-check failed, nothing was changed';
  END IF;
END
$postcheck$;

COMMIT;

-- ROLLBACK (not part of the change):
--   DROP INDEX public.pets_user_id_idx, public.appointments_user_id_idx, public.appointments_pet_id_idx,
--     public.appointments_appointment_date_idx, public.medical_records_pet_id_idx, public.email_verifications_user_id_idx,
--     public.activity_logs_user_id_created_at_idx, public.activity_logs_created_at_idx;
