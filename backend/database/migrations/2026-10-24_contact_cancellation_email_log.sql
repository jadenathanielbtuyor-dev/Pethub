-- =====================================================================================================
-- PetHub: signed-in contact messages with clinic replies, who cancelled an appointment, appointment status history,
-- and a delivery record for appointment and reply emails
-- Prepared 2026-10-24. Run once, as ONE script.
--
--   contact_messages   + user_id (the signed-in sender; the backend takes it from the session token, never from the
--                        request body), + subject, + reply_message (the clinic's answer, shown to the customer and
--                        emailed to the account's address). replied_at and handled_by already exist and are now used.
--                        status is limited to Unread | Read | Replied; message and subject lengths match the form.
--   appointments       + cancelled_by: the account that cancelled (the owner through POST /appointments/cancel/:id,
--                        or the admin through the dashboard). Lets the clinic tell "cancelled by owner" from
--                        "cancelled by clinic" without overloading handled_by (which keeps the approving admin).
--   cancel_appointment_for_owner, update_appointment_status_if_available
--                      Same signatures, same checks; they now also set cancelled_by. Everything else is unchanged.
--   appointment_status_history
--                      The existing (empty, unused) table is now filled by a trigger on every insert and status change,
--                      whichever path makes it (booking function, admin endpoints, SQL Editor). changed_by is the owner
--                      for a new booking, cancelled_by for a cancellation, otherwise handled_by (the admin).
--   email_logs         + appointment_id, + contact_message_id. Each appointment/reply email gets one row whose
--                        status goes Pending -> Sent | Failed; a unique index allows one row per appointment and email
--                        type, so a retried request can never send the same appointment email twice.
--
-- Verified 2026-10-24 before preparing: contact_messages 0 rows, email_logs 0 rows, appointment_status_history 0 rows,
-- appointments 2 rows (both Completed, so the cancelled_by check holds); the two function bodies match the md5 values
-- checked in PART 0 (the reconcile file's versions). Additive only: no existing row is changed or removed.
-- New functions get EXECUTE for anon/authenticated through this project's default privileges, so PART D revokes it.
-- =====================================================================================================

BEGIN;

-- PART 0: stop, changing nothing, unless the database is in the expected state
DO $preflight$
DECLARE
  problems text[] := ARRAY[]::text[];
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
             AND ((table_name = 'contact_messages' AND column_name IN ('user_id', 'subject', 'reply_message'))
               OR (table_name = 'appointments' AND column_name = 'cancelled_by')
               OR (table_name = 'email_logs' AND column_name IN ('appointment_id', 'contact_message_id')))) THEN
    problems := problems || 'one of the new columns already exists (has this file already run?)'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'contact_messages' AND column_name = 'replied_at')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'contact_messages' AND column_name = 'handled_by') THEN
    problems := problems || 'contact_messages.replied_at / handled_by are missing'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM public.contact_messages WHERE status IS NULL OR status NOT IN ('Unread', 'Read')
             OR char_length(message) NOT BETWEEN 1 AND 2000) THEN
    problems := problems || 'a contact message has a status other than Unread/Read or a message outside 1-2000 characters'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM public.email_logs WHERE status IS NOT NULL AND status NOT IN ('Pending', 'Sent', 'Failed')) THEN
    problems := problems || 'email_logs has a status outside Pending/Sent/Failed'::text;
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.cancel_appointment_for_owner(uuid,uuid,text)'::regprocedure)
       IS DISTINCT FROM 'ed8f7b5a956b8c7c3ffa3eac1732628c' THEN
    problems := problems || 'cancel_appointment_for_owner differs from the reviewed version'::text;
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.update_appointment_status_if_available(uuid,text,uuid,text)'::regprocedure)
       IS DISTINCT FROM '8fab234de47bf92e2e3910d2d405de6c' THEN
    problems := problems || 'update_appointment_status_if_available differs from the reviewed version'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'record_appointment_status_history')
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'appointments_record_status_history') THEN
    problems := problems || 'the status history function or trigger already exists'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname IN (
       'contact_messages_status_option', 'contact_messages_subject_length', 'contact_messages_message_length',
       'contact_messages_reply_length', 'contact_messages_reply_complete', 'appointments_cancelled_by_status',
       'email_logs_status_option')) THEN
    problems := problems || 'a constraint with one of the new names already exists'::text;
  END IF;
  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'PetHub contact/cancellation migration stopped, nothing was changed: %', array_to_string(problems, '; ');
  END IF;
END
$preflight$;

-- PART A: contact messages from signed-in customers, with the clinic's reply
ALTER TABLE public.contact_messages
  ADD COLUMN user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN subject text,
  ADD COLUMN reply_message text;

ALTER TABLE public.contact_messages
  ADD CONSTRAINT contact_messages_status_option CHECK (status IN ('Unread', 'Read', 'Replied')),
  ADD CONSTRAINT contact_messages_subject_length CHECK (subject IS NULL OR char_length(subject) BETWEEN 1 AND 120),
  ADD CONSTRAINT contact_messages_message_length CHECK (char_length(message) BETWEEN 1 AND 2000),
  ADD CONSTRAINT contact_messages_reply_length CHECK (reply_message IS NULL OR char_length(reply_message) BETWEEN 1 AND 2000),
  ADD CONSTRAINT contact_messages_reply_complete CHECK (status <> 'Replied' OR (reply_message IS NOT NULL AND replied_at IS NOT NULL));

CREATE INDEX contact_messages_user_id_created_at_idx ON public.contact_messages (user_id, created_at DESC);

-- PART B: who cancelled an appointment
ALTER TABLE public.appointments
  ADD COLUMN cancelled_by uuid REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.appointments
  ADD CONSTRAINT appointments_cancelled_by_status CHECK (cancelled_by IS NULL OR status = 'Cancelled');

-- PART C: the two appointment functions also record cancelled_by (bodies otherwise identical to the reviewed versions)
CREATE OR REPLACE FUNCTION public.cancel_appointment_for_owner(p_appointment_id uuid, p_owner_id uuid, p_expected_status text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  changed_rows integer;
BEGIN
  IF p_expected_status NOT IN ('Pending', 'Approved') THEN
    RETURN false;
  END IF;

  UPDATE public.appointments AS appointment
  SET status = 'Cancelled',
      cancelled_at = statement_timestamp(),
      cancelled_by = p_owner_id
  WHERE appointment.id = p_appointment_id
    AND appointment.user_id = p_owner_id
    AND appointment.status = p_expected_status
    AND ((appointment.appointment_date + appointment.appointment_time) AT TIME ZONE 'Asia/Manila')
          >= (statement_timestamp() + INTERVAL '2 hours');

  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  RETURN changed_rows = 1;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_appointment_status_if_available(p_appointment_id uuid, p_status text, p_handled_by uuid, p_expected_status text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  current_appointment public.appointments%ROWTYPE;
BEGIN
  IF p_appointment_id IS NULL OR p_status NOT IN ('Approved', 'Cancelled', 'Completed')
     OR p_handled_by IS NULL OR p_expected_status NOT IN ('Pending', 'Approved') THEN
    RAISE EXCEPTION 'Invalid appointment status request' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO current_appointment
  FROM public.appointments
  WHERE id = p_appointment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  IF current_appointment.status <> p_expected_status THEN
    RETURN jsonb_build_object('outcome', 'stale');
  END IF;
  IF NOT (
    (p_expected_status = 'Pending' AND p_status IN ('Approved', 'Cancelled'))
    OR (p_expected_status = 'Approved' AND p_status IN ('Completed', 'Cancelled'))
  ) THEN
    RAISE EXCEPTION 'Invalid appointment status transition' USING ERRCODE = '22023';
  END IF;

  IF p_status = 'Approved' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended((current_appointment.appointment_date - 1)::text, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended(current_appointment.appointment_date::text, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended((current_appointment.appointment_date + 1)::text, 0));

    IF EXISTS (
      SELECT 1
      FROM public.appointments AS appointment
      WHERE appointment.id <> p_appointment_id
        AND appointment.appointment_date BETWEEN current_appointment.appointment_date - 1 AND current_appointment.appointment_date + 1
        AND appointment.status IN ('Approved', 'Completed')
        AND appointment.appointment_time IS NOT NULL
        AND appointment.estimated_duration_minutes BETWEEN 5 AND 480
        AND (current_appointment.appointment_date + current_appointment.appointment_time)
              < (appointment.appointment_date + appointment.appointment_time)
                  + make_interval(mins => appointment.estimated_duration_minutes)
        AND (appointment.appointment_date + appointment.appointment_time)
              < (current_appointment.appointment_date + current_appointment.appointment_time)
                  + make_interval(mins => current_appointment.estimated_duration_minutes)
    ) THEN
      RETURN jsonb_build_object('outcome', 'conflict');
    END IF;
  END IF;

  UPDATE public.appointments
  SET status = p_status,
      handled_by = p_handled_by,
      cancelled_at = CASE WHEN p_status = 'Cancelled' THEN statement_timestamp() ELSE cancelled_at END,
      cancelled_by = CASE WHEN p_status = 'Cancelled' THEN p_handled_by ELSE cancelled_by END
  WHERE id = p_appointment_id AND status = p_expected_status;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'stale');
  END IF;

  RETURN jsonb_build_object('outcome', 'updated', 'appointment_id', p_appointment_id);
END;
$function$;

-- PART D: appointment status history, recorded by the database for every path
CREATE FUNCTION public.record_appointment_status_history()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.appointment_status_history (appointment_id, old_status, new_status, changed_by)
    VALUES (NEW.id, NULL, NEW.status, NEW.user_id);
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.appointment_status_history (appointment_id, old_status, new_status, changed_by)
    VALUES (NEW.id, OLD.status, NEW.status,
            CASE WHEN NEW.status = 'Cancelled' THEN NEW.cancelled_by ELSE NEW.handled_by END);
  END IF;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_appointment_status_history() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER appointments_record_status_history
  AFTER INSERT OR UPDATE OF status ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.record_appointment_status_history();

CREATE INDEX appointment_status_history_appointment_id_idx ON public.appointment_status_history (appointment_id, created_at);

-- PART E: a delivery record for each appointment and reply email
ALTER TABLE public.email_logs
  ADD COLUMN appointment_id uuid REFERENCES public.appointments(id) ON DELETE SET NULL,
  ADD COLUMN contact_message_id uuid REFERENCES public.contact_messages(id) ON DELETE SET NULL;

ALTER TABLE public.email_logs
  ADD CONSTRAINT email_logs_status_option CHECK (status IN ('Pending', 'Sent', 'Failed'));

CREATE UNIQUE INDEX email_logs_one_per_appointment_type ON public.email_logs (appointment_id, email_type) WHERE appointment_id IS NOT NULL;
CREATE UNIQUE INDEX email_logs_one_per_contact_message_type ON public.email_logs (contact_message_id, email_type) WHERE contact_message_id IS NOT NULL;

-- PART Z: verify before committing
DO $postcheck$
DECLARE
  problems text[] := ARRAY[]::text[];
BEGIN
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
      AND ((table_name = 'contact_messages' AND column_name IN ('user_id', 'subject', 'reply_message'))
        OR (table_name = 'appointments' AND column_name = 'cancelled_by')
        OR (table_name = 'email_logs' AND column_name IN ('appointment_id', 'contact_message_id')))) <> 6 THEN
    problems := problems || 'columns'::text;
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE convalidated AND conname IN (
       'contact_messages_status_option', 'contact_messages_subject_length', 'contact_messages_message_length',
       'contact_messages_reply_length', 'contact_messages_reply_complete', 'appointments_cancelled_by_status',
       'email_logs_status_option')) <> 7 THEN
    problems := problems || 'check constraints'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'appointments_record_status_history' AND tgenabled = 'O') THEN
    problems := problems || 'status history trigger'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) acl
             WHERE p.pronamespace = 'public'::regnamespace
               AND p.proname IN ('cancel_appointment_for_owner', 'update_appointment_status_if_available', 'record_appointment_status_history')
               AND acl.privilege_type = 'EXECUTE'
               AND acl.grantee IN (0, 'anon'::regrole, 'authenticated'::regrole)) THEN
    problems := problems || 'a function is executable by PUBLIC, anon or authenticated'::text;
  END IF;
  IF (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname IN (
       'contact_messages_user_id_created_at_idx', 'appointment_status_history_appointment_id_idx',
       'email_logs_one_per_appointment_type', 'email_logs_one_per_contact_message_type')) <> 4 THEN
    problems := problems || 'indexes'::text;
  END IF;
  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'PetHub contact/cancellation migration post-check failed (%), nothing was changed', array_to_string(problems, ', ');
  END IF;
END
$postcheck$;

COMMIT;

-- ROLLBACK (not part of the change; only if this migration must be undone, after removing the code that uses it):
--   DROP TRIGGER appointments_record_status_history ON public.appointments;
--   DROP FUNCTION public.record_appointment_status_history();
--   restore the previous bodies of cancel_appointment_for_owner and update_appointment_status_if_available (only their
--   function statements from PART E and PART F of 2026-10-23_reconcile_live_schema.sql, as CREATE OR REPLACE);
--   then drop the indexes, constraints and columns added above. Dropping columns deletes the data stored in them.
