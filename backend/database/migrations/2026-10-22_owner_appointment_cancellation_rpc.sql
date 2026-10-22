-- PetHub: atomically enforce the owner's cancellation cutoff against the database clock.
-- Prepared 2026-10-22. NOT APPLIED. Apply only after reviewing the target schema and approving the migration.
-- The function changes only Pending/Approved -> Cancelled. It never deletes a row or sets another status.
-- It creates no cancellation reason/timestamp field; the existing application attempts an activity-log event.
--
-- Read-only preflight: expected appointment_date = date; appointment_time = time without time zone; id and user_id = uuid;
-- status is text. Stop if the table or any type differs, or if the function already exists and has not been reviewed.
SELECT column_name, data_type, udt_name, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'appointments'
  AND column_name IN ('id', 'user_id', 'status', 'appointment_date', 'appointment_time')
ORDER BY column_name;

SELECT p.oid::regprocedure AS existing_function, p.prosecdef AS security_definer
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'cancel_appointment_for_owner';

BEGIN;

CREATE FUNCTION public.cancel_appointment_for_owner(
  p_appointment_id uuid,
  p_owner_id uuid,
  p_expected_status text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  changed_rows integer;
BEGIN
  IF p_expected_status NOT IN ('Pending', 'Approved') THEN
    RETURN false;
  END IF;

  UPDATE public.appointments AS appointment
  SET status = 'Cancelled'
  WHERE appointment.id = p_appointment_id
    AND appointment.user_id = p_owner_id
    AND appointment.status = p_expected_status
    AND ((appointment.appointment_date + appointment.appointment_time) AT TIME ZONE 'Asia/Manila')
          >= (statement_timestamp() + INTERVAL '2 hours');

  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  RETURN changed_rows = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_appointment_for_owner(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_appointment_for_owner(uuid, uuid, text) TO service_role;

COMMIT;
NOTIFY pgrst, 'reload schema';

-- Post-migration verification (read-only): function exists, is SECURITY INVOKER, and only service_role can execute it.
SELECT p.oid::regprocedure AS function_name, p.prosecdef AS security_definer,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'cancel_appointment_for_owner';

-- In staging, create an eligible fixture and verify exact two-hour boundary and concurrent calls; roll test data back.
-- Recovery/rollback: first roll back backend code so it no longer calls this function, then (only if approved) drop it:
--   DROP FUNCTION public.cancel_appointment_for_owner(uuid, uuid, text);
-- This function has no stored data to recover. Cancelling appointments is a data change; never use production rows for
-- boundary tests.
