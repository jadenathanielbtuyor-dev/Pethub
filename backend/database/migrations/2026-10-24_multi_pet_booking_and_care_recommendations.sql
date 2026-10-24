-- =====================================================================================================
-- PetHub: multi-pet bookings, clinic rescheduling, typed service activity, and pet care recommendations
-- Prepared 2026-10-24. Run once, as ONE script, BEFORE deploying the backend that uses it.
--
--   appointment_groups      One row per multi-pet booking request (the owner's overall booking). Each pet keeps its
--                           own appointments row (pet, service, duration, time, status), linked by group_id and
--                           ordered by group_position, so every existing single-pet query, admin action, email and
--                           status-history entry keeps working per pet. Single-pet bookings have group_id NULL.
--   create_appointment_group_if_available
--                           Checks every pet (owned by the account, species offered) and every service (open, same
--                           duration and name as the catalog) under the catalog row locks, then, under the same per-date
--                           locks as single bookings, checks that each pet's slot is free and inserts the group and
--                           all its appointments. Pets are seen one after another (sequential), because the clinic
--                           schedule allows one appointment at a time. Either everything is saved or nothing is.
--   cancel_appointment_group_by_clinic
--                           Cancels every still-open appointment of one booking in one transaction; each change is
--                           recorded per pet by the existing status-history trigger.
--   reschedule_appointment_if_available
--                           Moves one Pending/Approved appointment to a free slot (the clinic's reschedule).
--   activity_logs.event_type
--                           A machine-readable type for new service-catalog activity (created, updated, activated,
--                           deactivated, care rule changes), so the service activity history can be filtered.
--                           Existing rows are not changed (NULL = recorded before types existed).
--   care_recommendation_rules
--                           Clinic-configured follow-up guidance per service (optionally per species): a suggested
--                           interval range, a description and whether it is general guidance or veterinarian-approved.
--                           NO rules are created here: the clinic configures them in the Admin Dashboard.
--   pet_care_recommendations
--                           The suggestion made for one pet after one completed appointment (or set by the clinic),
--                           with its source, rule and explanation kept for audit. One open suggestion per source.
--
-- Additive only: no existing row is changed or removed. New tables get privileges for anon/authenticated through this
-- project's default privileges, and new functions get EXECUTE for PUBLIC, so PART G revokes both; RLS is on with no
-- policies like every other PetHub table (only the backend, with the service role, uses them).
-- =====================================================================================================

BEGIN;

-- PART 0: stop, changing nothing, unless the database is in the expected state
DO $preflight$
DECLARE
  problems text[] := ARRAY[]::text[];
BEGIN
  IF to_regclass('public.appointment_groups') IS NOT NULL OR to_regclass('public.care_recommendation_rules') IS NOT NULL
     OR to_regclass('public.pet_care_recommendations') IS NOT NULL THEN
    problems := problems || 'a new table already exists (has this file already run?)'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
             AND ((table_name = 'appointments' AND column_name IN ('group_id', 'group_position'))
               OR (table_name = 'activity_logs' AND column_name = 'event_type'))) THEN
    problems := problems || 'a new column already exists'::text;
  END IF;
  IF to_regprocedure('public.create_appointment_group_if_available(uuid,date,time,text,jsonb)') IS NOT NULL
     OR to_regprocedure('public.cancel_appointment_group_by_clinic(uuid,uuid)') IS NOT NULL
     OR to_regprocedure('public.reschedule_appointment_if_available(uuid,date,time,uuid,text,date,time)') IS NOT NULL THEN
    problems := problems || 'a new function already exists'::text;
  END IF;
  IF to_regclass('public.user_sessions') IS NULL OR to_regclass('public.pethub_service_catalog') IS NULL THEN
    problems := problems || 'expected earlier migrations (user_sessions, service catalog) are missing'::text;
  END IF;
  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'PetHub multi-pet/recommendations preflight failed (%), nothing was changed', array_to_string(problems, ', ');
  END IF;
END
$preflight$;

-- PART A: multi-pet bookings
CREATE TABLE public.appointment_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  appointment_date date NOT NULL,
  start_time time NOT NULL,
  scheduling text NOT NULL DEFAULT 'sequential',
  request_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT appointment_groups_scheduling_option CHECK (scheduling = 'sequential'),
  CONSTRAINT appointment_groups_request_key_format CHECK (request_key ~ '^[0-9a-f]{64}$')
);
CREATE INDEX appointment_groups_user_request_idx ON public.appointment_groups (user_id, request_key);

ALTER TABLE public.appointments
  ADD COLUMN group_id uuid REFERENCES public.appointment_groups(id),
  ADD COLUMN group_position smallint;
ALTER TABLE public.appointments
  ADD CONSTRAINT appointments_group_position_pair CHECK ((group_id IS NULL) = (group_position IS NULL)),
  ADD CONSTRAINT appointments_group_position_range CHECK (group_position IS NULL OR group_position BETWEEN 1 AND 6);
CREATE UNIQUE INDEX appointments_group_position_key ON public.appointments (group_id, group_position) WHERE group_id IS NOT NULL;
CREATE UNIQUE INDEX appointments_group_pet_key ON public.appointments (group_id, pet_id) WHERE group_id IS NOT NULL;

-- PART B: book several pets in one transaction (p_items: [{pet_id, service_id, service_type, duration_minutes}, ...]
-- in the order the pets will be seen)
CREATE FUNCTION public.create_appointment_group_if_available(
  p_user_id uuid, p_appointment_date date, p_start_time time, p_request_key text, p_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  item jsonb;
  item_position integer;
  item_count integer;
  total_minutes integer := 0;
  current_service public.pethub_service_catalog%ROWTYPE;
  current_pet public.pets%ROWTYPE;
  slot_start timestamp;
  slot_end timestamp;
  existing_group uuid;
  created_group uuid;
  created_ids uuid[] := ARRAY[]::uuid[];
  new_id uuid;
BEGIN
  IF p_user_id IS NULL OR p_appointment_date IS NULL OR p_start_time IS NULL
     OR p_request_key IS NULL OR p_request_key !~ '^[0-9a-f]{64}$'
     OR p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'Invalid booking request' USING ERRCODE = '22023';
  END IF;
  item_count := jsonb_array_length(p_items);
  IF item_count < 2 OR item_count > 6
     OR (SELECT count(DISTINCT value->>'pet_id') FROM jsonb_array_elements(p_items)) <> item_count
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_items)
                WHERE (value->>'duration_minutes') IS NULL OR (value->>'duration_minutes')::integer NOT BETWEEN 5 AND 480) THEN
    RAISE EXCEPTION 'Invalid booking request' USING ERRCODE = '22023';
  END IF;

  -- Lock the services in a fixed order so concurrent bookings cannot deadlock, then recheck every pet and service
  PERFORM 1 FROM public.pethub_service_catalog
  WHERE id IN (SELECT (value->>'service_id')::uuid FROM jsonb_array_elements(p_items))
  ORDER BY id
  FOR SHARE;

  FOR item, item_position IN
    SELECT value, ordinality::integer FROM jsonb_array_elements(p_items) WITH ORDINALITY ORDER BY ordinality
  LOOP
    SELECT * INTO current_service FROM public.pethub_service_catalog WHERE id = (item->>'service_id')::uuid;
    IF NOT FOUND OR current_service.online_booking_enabled IS NOT TRUE
       OR current_service.duration_minutes IS DISTINCT FROM (item->>'duration_minutes')::integer
       OR current_service.name IS DISTINCT FROM item->>'service_type' THEN
      RETURN jsonb_build_object('outcome', 'service_changed', 'position', item_position);
    END IF;
    SELECT * INTO current_pet FROM public.pets WHERE id = (item->>'pet_id')::uuid AND user_id = p_user_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('outcome', 'pet_not_found', 'position', item_position);
    END IF;
    IF NOT (current_pet.species = ANY(current_service.species)) THEN
      RETURN jsonb_build_object('outcome', 'species_not_offered', 'position', item_position);
    END IF;
    total_minutes := total_minutes + current_service.duration_minutes;
  END LOOP;

  -- The whole booking finishes the same day
  IF (p_appointment_date + p_start_time) + make_interval(mins => total_minutes) > (p_appointment_date + 1)::timestamp THEN
    RETURN jsonb_build_object('outcome', 'past_end_of_day');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended((p_appointment_date - 1)::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_appointment_date::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended((p_appointment_date + 1)::text, 0));

  -- A repeated request (double click, retry) returns the booking already made while all of its pets are still Pending
  SELECT booking.id INTO existing_group
  FROM public.appointment_groups AS booking
  WHERE booking.user_id = p_user_id AND booking.request_key = p_request_key
    AND NOT EXISTS (SELECT 1 FROM public.appointments AS a WHERE a.group_id = booking.id AND a.status <> 'Pending')
  ORDER BY booking.created_at DESC
  LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('outcome', 'existing', 'group_id', existing_group);
  END IF;

  -- Each pet's slot starts when the previous pet's ends; none may overlap another active appointment
  slot_start := p_appointment_date + p_start_time;
  FOR item, item_position IN
    SELECT value, ordinality::integer FROM jsonb_array_elements(p_items) WITH ORDINALITY ORDER BY ordinality
  LOOP
    slot_end := slot_start + make_interval(mins => (item->>'duration_minutes')::integer);
    IF EXISTS (
      SELECT 1
      FROM public.appointments AS appointment
      WHERE appointment.appointment_date BETWEEN p_appointment_date - 1 AND p_appointment_date + 1
        AND appointment.status IN ('Pending', 'Approved', 'Completed')
        AND appointment.appointment_time IS NOT NULL
        AND appointment.estimated_duration_minutes BETWEEN 5 AND 480
        AND slot_start < (appointment.appointment_date + appointment.appointment_time)
                           + make_interval(mins => appointment.estimated_duration_minutes)
        AND (appointment.appointment_date + appointment.appointment_time) < slot_end
    ) THEN
      RETURN jsonb_build_object('outcome', 'conflict', 'position', item_position);
    END IF;
    slot_start := slot_end;
  END LOOP;

  INSERT INTO public.appointment_groups (user_id, appointment_date, start_time, request_key)
  VALUES (p_user_id, p_appointment_date, p_start_time, p_request_key)
  RETURNING id INTO created_group;

  slot_start := p_appointment_date + p_start_time;
  FOR item, item_position IN
    SELECT value, ordinality::integer FROM jsonb_array_elements(p_items) WITH ORDINALITY ORDER BY ordinality
  LOOP
    INSERT INTO public.appointments
      (user_id, pet_id, pet_name, service_type, estimated_duration_minutes, appointment_date, appointment_time, status,
       group_id, group_position)
    SELECT p_user_id, pet.id, pet.name, item->>'service_type', (item->>'duration_minutes')::integer,
           slot_start::date, slot_start::time, 'Pending', created_group, item_position
    FROM public.pets AS pet
    WHERE pet.id = (item->>'pet_id')::uuid
    RETURNING id INTO new_id;
    created_ids := created_ids || new_id;
    slot_start := slot_start + make_interval(mins => (item->>'duration_minutes')::integer);
  END LOOP;

  RETURN jsonb_build_object('outcome', 'created', 'group_id', created_group, 'appointment_ids', to_jsonb(created_ids));
END;
$function$;

-- PART C: the clinic cancels a whole multi-pet booking (every still-open pet appointment, in one transaction)
CREATE FUNCTION public.cancel_appointment_group_by_clinic(p_group_id uuid, p_handled_by uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  cancelled_ids uuid[];
BEGIN
  IF p_group_id IS NULL OR p_handled_by IS NULL THEN
    RAISE EXCEPTION 'Invalid booking cancellation request' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.appointment_groups WHERE id = p_group_id) THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  PERFORM 1 FROM public.appointments WHERE group_id = p_group_id ORDER BY group_position FOR UPDATE;

  WITH changed AS (
    UPDATE public.appointments
    SET status = 'Cancelled', handled_by = p_handled_by, cancelled_at = statement_timestamp(), cancelled_by = p_handled_by
    WHERE group_id = p_group_id AND status IN ('Pending', 'Approved')
    RETURNING id, group_position
  )
  SELECT coalesce(array_agg(id ORDER BY group_position), ARRAY[]::uuid[]) INTO cancelled_ids FROM changed;

  RETURN jsonb_build_object(
    'outcome', CASE WHEN cardinality(cancelled_ids) > 0 THEN 'cancelled' ELSE 'nothing_to_cancel' END,
    'appointment_ids', to_jsonb(cancelled_ids)
  );
END;
$function$;

-- PART D: the clinic moves one Pending/Approved appointment to a free slot. The expected status, date and time must
-- still match (another admin may have changed it); the slot is checked under the same per-date locks as bookings.
CREATE FUNCTION public.reschedule_appointment_if_available(
  p_appointment_id uuid, p_new_date date, p_new_time time, p_handled_by uuid,
  p_expected_status text, p_expected_date date, p_expected_time time)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  current_appointment public.appointments%ROWTYPE;
  lock_date date;
BEGIN
  IF p_appointment_id IS NULL OR p_new_date IS NULL OR p_new_time IS NULL OR p_handled_by IS NULL
     OR p_expected_status NOT IN ('Pending', 'Approved') OR p_expected_date IS NULL OR p_expected_time IS NULL THEN
    RAISE EXCEPTION 'Invalid reschedule request' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO current_appointment FROM public.appointments WHERE id = p_appointment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  IF current_appointment.status <> p_expected_status
     OR current_appointment.appointment_date IS DISTINCT FROM p_expected_date
     OR current_appointment.appointment_time IS DISTINCT FROM p_expected_time THEN
    RETURN jsonb_build_object('outcome', 'stale');
  END IF;
  IF current_appointment.estimated_duration_minutes IS NULL
     OR current_appointment.estimated_duration_minutes NOT BETWEEN 5 AND 480 THEN
    RETURN jsonb_build_object('outcome', 'invalid_duration');
  END IF;
  IF (p_new_date + p_new_time) + make_interval(mins => current_appointment.estimated_duration_minutes) > (p_new_date + 1)::timestamp THEN
    RETURN jsonb_build_object('outcome', 'past_end_of_day');
  END IF;

  -- The same per-date locks as bookings, for the new date and its neighbours, taken in date order
  FOR lock_date IN SELECT d::date FROM generate_series(p_new_date - 1, p_new_date + 1, interval '1 day') AS d ORDER BY 1 LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(lock_date::text, 0));
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM public.appointments AS appointment
    WHERE appointment.id <> p_appointment_id
      AND appointment.appointment_date BETWEEN p_new_date - 1 AND p_new_date + 1
      AND appointment.status IN ('Pending', 'Approved', 'Completed')
      AND appointment.appointment_time IS NOT NULL
      AND appointment.estimated_duration_minutes BETWEEN 5 AND 480
      AND (p_new_date + p_new_time) < (appointment.appointment_date + appointment.appointment_time)
                                       + make_interval(mins => appointment.estimated_duration_minutes)
      AND (appointment.appointment_date + appointment.appointment_time)
            < (p_new_date + p_new_time) + make_interval(mins => current_appointment.estimated_duration_minutes)
  ) THEN
    RETURN jsonb_build_object('outcome', 'conflict');
  END IF;

  UPDATE public.appointments
  SET appointment_date = p_new_date, appointment_time = p_new_time, handled_by = p_handled_by
  WHERE id = p_appointment_id;

  RETURN jsonb_build_object('outcome', 'updated', 'appointment_id', p_appointment_id,
    'previous_date', current_appointment.appointment_date, 'previous_time', current_appointment.appointment_time);
END;
$function$;

-- PART E: typed activity for the service catalog (existing rows keep NULL)
ALTER TABLE public.activity_logs ADD COLUMN event_type text;
ALTER TABLE public.activity_logs
  ADD CONSTRAINT activity_logs_event_type_format CHECK (event_type IS NULL OR event_type ~ '^[a-z][a-z_]{2,48}$');
CREATE INDEX activity_logs_target_table_created_at_idx ON public.activity_logs (target_table, created_at DESC);

-- PART F: care recommendation rules and the suggestions made for each pet
CREATE TABLE public.care_recommendation_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL REFERENCES public.pethub_service_catalog(id) ON DELETE RESTRICT,
  species text,
  min_interval_days integer NOT NULL,
  max_interval_days integer NOT NULL,
  guidance_type text NOT NULL,
  description text NOT NULL,
  explanation text NOT NULL DEFAULT '',
  is_active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT care_rules_species_option CHECK (species IS NULL OR species IN ('Dog', 'Cat')),
  CONSTRAINT care_rules_interval_range CHECK (min_interval_days BETWEEN 1 AND 1825 AND max_interval_days BETWEEN min_interval_days AND 1825),
  CONSTRAINT care_rules_guidance_option CHECK (guidance_type IN ('general', 'veterinarian_approved')),
  CONSTRAINT care_rules_description_length CHECK (char_length(btrim(description)) BETWEEN 1 AND 300),
  CONSTRAINT care_rules_explanation_length CHECK (char_length(explanation) <= 600),
  CONSTRAINT care_rules_version_positive CHECK (version > 0)
);
-- One rule per service for all species (species NULL) and at most one per specific species
CREATE UNIQUE INDEX care_rules_service_species_key ON public.care_recommendation_rules (service_id, coalesce(species, 'All'));

CREATE TABLE public.pet_care_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pet_id uuid NOT NULL REFERENCES public.pets(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  service_id uuid REFERENCES public.pethub_service_catalog(id) ON DELETE SET NULL,
  service_name text NOT NULL,
  source_appointment_id uuid REFERENCES public.appointments(id) ON DELETE SET NULL,
  rule_id uuid REFERENCES public.care_recommendation_rules(id) ON DELETE SET NULL,
  basis text NOT NULL,
  guidance_type text,
  service_date date NOT NULL,
  due_from date,
  due_to date,
  explanation text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  set_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  dismissed_at timestamptz,
  CONSTRAINT pet_care_basis_option CHECK (basis IN ('rule', 'clinic_set', 'needs_review')),
  CONSTRAINT pet_care_guidance_option CHECK (guidance_type IS NULL OR guidance_type IN ('general', 'veterinarian_approved')),
  CONSTRAINT pet_care_status_option CHECK (status IN ('active', 'acknowledged', 'dismissed', 'superseded')),
  CONSTRAINT pet_care_dates_match_basis CHECK (((basis = 'needs_review') = (due_from IS NULL)) AND (due_to IS NULL OR (due_from IS NOT NULL AND due_to >= due_from))),
  CONSTRAINT pet_care_explanation_length CHECK (char_length(explanation) BETWEEN 1 AND 800),
  CONSTRAINT pet_care_service_name_length CHECK (char_length(btrim(service_name)) BETWEEN 1 AND 100)
);
-- A completed appointment produces at most one open suggestion (a clinic override supersedes it and takes its place)
CREATE UNIQUE INDEX pet_care_one_open_per_source ON public.pet_care_recommendations (source_appointment_id)
  WHERE source_appointment_id IS NOT NULL AND status <> 'superseded';
CREATE INDEX pet_care_user_status_due_idx ON public.pet_care_recommendations (user_id, status, due_from);
CREATE INDEX pet_care_pet_created_idx ON public.pet_care_recommendations (pet_id, created_at DESC);

-- PART G: backend only (service role), like every other PetHub table and function
ALTER TABLE public.appointment_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.care_recommendation_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pet_care_recommendations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.appointment_groups, public.care_recommendation_rules, public.pet_care_recommendations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.appointment_groups, public.care_recommendation_rules, public.pet_care_recommendations TO service_role;
REVOKE ALL ON FUNCTION public.create_appointment_group_if_available(uuid, date, time, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cancel_appointment_group_by_clinic(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reschedule_appointment_if_available(uuid, date, time, uuid, text, date, time) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_appointment_group_if_available(uuid, date, time, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.cancel_appointment_group_by_clinic(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.reschedule_appointment_if_available(uuid, date, time, uuid, text, date, time) TO service_role;

-- PART Z: verify before committing
DO $postcheck$
DECLARE
  problems text[] := ARRAY[]::text[];
BEGIN
  IF (SELECT count(*) FROM pg_class WHERE oid IN ('public.appointment_groups'::regclass, 'public.care_recommendation_rules'::regclass,
       'public.pet_care_recommendations'::regclass) AND relrowsecurity) <> 3 THEN
    problems := problems || 'RLS'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_schema = 'public'
             AND table_name IN ('appointment_groups', 'care_recommendation_rules', 'pet_care_recommendations')
             AND grantee IN ('PUBLIC', 'anon', 'authenticated')) THEN
    problems := problems || 'an API role still has a table privilege'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) acl
             WHERE p.pronamespace = 'public'::regnamespace
               AND p.proname IN ('create_appointment_group_if_available', 'cancel_appointment_group_by_clinic', 'reschedule_appointment_if_available')
               AND acl.privilege_type = 'EXECUTE' AND acl.grantee IN (0, 'anon'::regrole, 'authenticated'::regrole)) THEN
    problems := problems || 'a new function is executable by PUBLIC, anon or authenticated'::text;
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
      AND ((table_name = 'appointments' AND column_name IN ('group_id', 'group_position'))
        OR (table_name = 'activity_logs' AND column_name = 'event_type'))) <> 3 THEN
    problems := problems || 'columns'::text;
  END IF;
  IF (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname IN (
       'appointment_groups_user_request_idx', 'appointments_group_position_key', 'appointments_group_pet_key',
       'activity_logs_target_table_created_at_idx', 'care_rules_service_species_key', 'pet_care_one_open_per_source',
       'pet_care_user_status_due_idx', 'pet_care_pet_created_idx')) <> 8 THEN
    problems := problems || 'indexes'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM public.appointments WHERE group_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.activity_logs WHERE event_type IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.care_recommendation_rules) THEN
    problems := problems || 'existing rows were changed or rules were seeded'::text;
  END IF;
  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'PetHub multi-pet/recommendations post-check failed (%), nothing was changed', array_to_string(problems, ', ');
  END IF;
END
$postcheck$;

COMMIT;

-- ROLLBACK (not part of the change; only after removing the code that uses it):
--   DROP FUNCTION public.reschedule_appointment_if_available(uuid, date, time, uuid, text, date, time);
--   DROP FUNCTION public.cancel_appointment_group_by_clinic(uuid, uuid);
--   DROP FUNCTION public.create_appointment_group_if_available(uuid, date, time, text, jsonb);
--   DROP TABLE public.pet_care_recommendations; DROP TABLE public.care_recommendation_rules;
--   ALTER TABLE public.activity_logs DROP COLUMN event_type;
--   ALTER TABLE public.appointments DROP COLUMN group_position, DROP COLUMN group_id; DROP TABLE public.appointment_groups;
--   (dropping them deletes the bookings' grouping, the rules and the suggestions stored in them)
