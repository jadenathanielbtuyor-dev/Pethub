-- PetHub: persistent service configuration and database-atomic booking inserts.
-- Prepared 2026-10-23. NOT APPLIED. Review the target schema and approve before running.
--
-- The current application stores service details/durations in backend source and every duration is unconfirmed.
-- This table becomes the runtime source of truth. The nine current entries are seeded disabled with no durations.
-- Puppy Cut has an empty species list because its species rule is explicitly awaiting clinic confirmation.
-- No prices, hours, capacity, lead times or appointment policies are invented here.
--
-- Read-only preflight (run separately):
--   SELECT column_name, data_type, udt_name, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'appointments'
--   ORDER BY ordinal_position;
--   SELECT column_name, data_type, udt_name, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'pets'
--     AND column_name IN ('id', 'user_id', 'species')
--   ORDER BY ordinal_position;
--   SELECT p.oid::regprocedure AS function_name
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.proname IN ('create_appointment_if_available', 'update_appointment_status_if_available');
-- Stop if pethub_service_catalog or either RPC already exists, if users.id/pets.id/pets.user_id/appointments.id/
-- appointments.user_id/appointments.pet_id are not UUIDs, if pets.species is not text, if appointment_date is not DATE,
-- if appointment_time is not TIME, or if the required appointment columns do not exist.
-- Confirm the backend uses a server-only service_role key. The function/table are not exposed to anon/authenticated.

BEGIN;

CREATE TABLE public.pethub_service_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_key text NOT NULL UNIQUE CHECK (service_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name varchar(100) NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  description varchar(500) NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  category text NOT NULL CHECK (category IN ('grooming', 'veterinary')),
  species text[] NOT NULL DEFAULT ARRAY[]::text[] CHECK (species <@ ARRAY['Dog', 'Cat']::text[]),
  duration_minutes integer CHECK (duration_minutes IS NULL OR duration_minutes BETWEEN 5 AND 480),
  online_booking_enabled boolean NOT NULL DEFAULT false,
  display_order integer NOT NULL CHECK (display_order BETWEEN 1 AND 99),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pethub_service_catalog_booking_configured_check
    CHECK (NOT online_booking_enabled OR (duration_minutes IS NOT NULL AND cardinality(species) > 0))
);

CREATE UNIQUE INDEX pethub_service_catalog_name_ci_key
  ON public.pethub_service_catalog (lower(btrim(name)));
CREATE INDEX pethub_service_catalog_order_idx
  ON public.pethub_service_catalog (display_order, id);

INSERT INTO public.pethub_service_catalog
  (service_key, name, description, category, species, duration_minutes, online_booking_enabled, display_order)
VALUES
  ('bath', 'Bath', 'A bath for your dog or cat.', 'grooming', ARRAY['Dog', 'Cat']::text[], NULL, false, 1),
  ('trim', 'Trim', 'A trim of your pet''s coat.', 'grooming', ARRAY['Dog', 'Cat']::text[], NULL, false, 2),
  ('puppy-cut', 'Puppy Cut', 'A short, even haircut all over the coat.', 'grooming', ARRAY[]::text[], NULL, false, 3),
  ('full-grooming', 'Full Grooming', 'A full grooming session for your dog or cat.', 'grooming', ARRAY['Dog', 'Cat']::text[], NULL, false, 4),
  ('nail-cutting', 'Nail Cutting', 'Trimming of your pet''s nails.', 'grooming', ARRAY['Dog', 'Cat']::text[], NULL, false, 5),
  ('face-trim', 'Face Trim', 'A trim of the fur around your pet’s face.', 'grooming', ARRAY['Dog', 'Cat']::text[], NULL, false, 6),
  ('flea-and-tick-removal', 'Flea and Tick Removal', 'Removal of fleas and ticks from your pet’s coat.', 'grooming', ARRAY['Dog', 'Cat']::text[], NULL, false, 7),
  ('medicated-bath', 'Medicated Bath', 'A bath using a medicated product.', 'grooming', ARRAY['Dog', 'Cat']::text[], NULL, false, 8),
  ('dog-cat-full-check-up', 'Dog & Cat Full Check Up', 'A full veterinary check-up for your dog or cat.', 'veterinary', ARRAY['Dog', 'Cat']::text[], NULL, false, 9);

ALTER TABLE public.pethub_service_catalog ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pethub_service_catalog FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pethub_service_catalog TO service_role;

COMMENT ON TABLE public.pethub_service_catalog IS
  'PetHub runtime service catalog. Booking stays closed until a clinic administrator sets a confirmed duration, applicable species, and enables the service.';
COMMENT ON COLUMN public.pethub_service_catalog.version IS
  'Optimistic concurrency token for administrator configuration updates.';
COMMENT ON COLUMN public.pethub_service_catalog.species IS
  'Clinic-confirmed applicable species. Empty means not configured; allowed values are Dog and Cat.';

CREATE FUNCTION public.create_appointment_if_available(
  p_service_id uuid,
  p_user_id uuid,
  p_pet_id uuid,
  p_pet_name text,
  p_service_type text,
  p_estimated_duration_minutes integer,
  p_appointment_date date,
  p_appointment_time time without time zone
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  existing_appointment_id uuid;
  created_appointment_id uuid;
  current_service public.pethub_service_catalog%ROWTYPE;
BEGIN
  IF p_service_id IS NULL OR p_user_id IS NULL OR p_pet_id IS NULL OR p_service_type IS NULL
     OR p_appointment_date IS NULL OR p_appointment_time IS NULL
     OR p_estimated_duration_minutes IS NULL
     OR p_estimated_duration_minutes NOT BETWEEN 5 AND 480 THEN
    RAISE EXCEPTION 'Invalid appointment request' USING ERRCODE = '22023';
  END IF;

  -- Recheck the current catalog under a row lock so a concurrent disable or duration/species edit
  -- cannot slip between the API lookup and the reservation.
  SELECT * INTO current_service
  FROM public.pethub_service_catalog
  WHERE id = p_service_id
  FOR SHARE;

  IF NOT FOUND OR current_service.online_booking_enabled IS NOT TRUE
     OR current_service.duration_minutes IS DISTINCT FROM p_estimated_duration_minutes
     OR current_service.name IS DISTINCT FROM p_service_type
     OR NOT EXISTS (
       SELECT 1 FROM public.pets AS pet
       WHERE pet.id = p_pet_id AND pet.user_id = p_user_id
         AND pet.species = ANY(current_service.species)
     ) THEN
    RAISE EXCEPTION 'Service or pet booking configuration changed' USING ERRCODE = 'P0001';
  END IF;

  -- Lock adjacent dates in order as appointments may extend across midnight.
  PERFORM pg_advisory_xact_lock(hashtextextended((p_appointment_date - 1)::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_appointment_date::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended((p_appointment_date + 1)::text, 0));

  SELECT id INTO existing_appointment_id
  FROM public.appointments
  WHERE user_id = p_user_id
    AND pet_id = p_pet_id
    AND service_type = p_service_type
    AND appointment_date = p_appointment_date
    AND appointment_time = p_appointment_time
    AND status = 'Pending'
  ORDER BY created_at DESC
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object('outcome', 'existing', 'appointment_id', existing_appointment_id);
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.appointments AS appointment
    WHERE appointment.appointment_date BETWEEN p_appointment_date - 1 AND p_appointment_date + 1
      AND appointment.status IN ('Pending', 'Approved', 'Completed')
      AND appointment.appointment_time IS NOT NULL
      AND appointment.estimated_duration_minutes BETWEEN 5 AND 480
      AND (p_appointment_date + p_appointment_time)
            < (appointment.appointment_date + appointment.appointment_time)
                + make_interval(mins => appointment.estimated_duration_minutes)
      AND (appointment.appointment_date + appointment.appointment_time)
            < (p_appointment_date + p_appointment_time)
                + make_interval(mins => p_estimated_duration_minutes)
  ) THEN
    RETURN jsonb_build_object('outcome', 'conflict');
  END IF;

  INSERT INTO public.appointments
    (user_id, pet_id, pet_name, service_type, estimated_duration_minutes, appointment_date, appointment_time, status)
  VALUES
    (p_user_id, p_pet_id, p_pet_name, p_service_type, p_estimated_duration_minutes, p_appointment_date, p_appointment_time, 'Pending')
  RETURNING id INTO created_appointment_id;

  RETURN jsonb_build_object('outcome', 'created', 'appointment_id', created_appointment_id);
END;
$$;

REVOKE ALL ON FUNCTION public.create_appointment_if_available(uuid, uuid, uuid, text, text, integer, date, time without time zone)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_appointment_if_available(uuid, uuid, uuid, text, text, integer, date, time without time zone)
  TO service_role;

-- Admin approvals share the same per-date advisory lock as customer bookings, so separate backend instances
-- cannot approve an overlapping appointment while another customer reserves that date.
CREATE FUNCTION public.update_appointment_status_if_available(
  p_appointment_id uuid,
  p_status text,
  p_handled_by uuid,
  p_expected_status text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
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
  SET status = p_status, handled_by = p_handled_by
  WHERE id = p_appointment_id AND status = p_expected_status;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'stale');
  END IF;

  RETURN jsonb_build_object('outcome', 'updated', 'appointment_id', p_appointment_id);
END;
$$;

REVOKE ALL ON FUNCTION public.update_appointment_status_if_available(uuid, text, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_appointment_status_if_available(uuid, text, uuid, text)
  TO service_role;

COMMIT;
NOTIFY pgrst, 'reload schema';

-- Post-migration checks (read-only):
--   SELECT service_key, name, category, species, duration_minutes, online_booking_enabled, display_order, version
--   FROM public.pethub_service_catalog ORDER BY display_order;
--   SELECT p.oid::regprocedure AS function_name, p.prosecdef AS security_definer,
--          has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute,
--          has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_can_execute
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.proname IN ('create_appointment_if_available', 'update_appointment_status_if_available');
-- In staging only, test concurrent overlapping reservations using fixtures, then remove the fixtures.
--
-- Rollback: first deploy code that no longer calls the RPC/catalog. Export administrator-entered configuration before
-- dropping the table. Existing appointment rows and their saved service names/durations are not changed by this
-- migration. After backing up configuration, an approved operator may run:
--   DROP FUNCTION IF EXISTS public.create_appointment_if_available(uuid, uuid, uuid, text, text, integer, date, time without time zone);
--   DROP FUNCTION IF EXISTS public.update_appointment_status_if_available(uuid, text, uuid, text);
--   DROP TABLE IF EXISTS public.pethub_service_catalog;
