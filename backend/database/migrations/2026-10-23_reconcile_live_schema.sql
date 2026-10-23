-- =====================================================================================================
-- PetHub: bring the live Supabase database up to the schema the deployed backend already uses
-- Prepared 2026-10-23 from a READ-ONLY inspection of the PetHub Supabase project (production). NOT APPLIED.
-- Run in the Supabase SQL Editor only after explicit approval, as ONE script (it is one transaction).
--
-- WHY (verified 2026-10-23 through the read-only Supabase MCP; transaction_read_only = on):
--   * Railway runs the current backend (it requests pethub_service_catalog, added in commit bfc5adc), but none of the
--     migrations below were applied. supabase_migrations.schema_migrations does not exist (SQL Editor history only).
--   * Postgres log "column users.date_of_birth does not exist" (13x since 2026-10-22 17:03Z): every registration
--     answers 503 and the dashboard profile cannot be read or saved.
--   * Postgres log "column medical_records.appointment_id does not exist" (20x since 2026-10-23 03:12Z, Railway):
--     admin Appointment Management (500), owner pet history (500), owner medical records (500) and every new official
--     medical record fail.
--   * pethub_service_catalog, pet_breed_catalog and owner_pet_weight_reports answer PostgREST 404: the Services page,
--     booking page and admin service settings answer 503; creating or editing a pet with a listed breed answers 503.
--   * public has no functions: owner cancellation, booking and admin approval answer 503.
--   * password_resets.attempts (with its CHECK) exists, but password_resets_one_open_code_per_user does not.
--
-- WHAT (each part is the reviewed DDL of an earlier file; running this file replaces running those files):
--   PART A  2026-10-20_users_profile_fields.sql PART 2              unchanged
--   PART B  2026-10-17_password_resets_attempts_and_rls.sql D1b     index only (D1 already applied; D2 is in the RLS file)
--   PART C  2026-10-22_breed_catalog_and_owner_weight_reports.sql   unchanged
--   PART D  2026-10-22_medical_record_appointment_link.sql          unchanged
--   PART E  2026-10-22_owner_appointment_cancellation_rpc.sql       now also sets appointments.cancelled_at
--   PART F  2026-10-23_service_catalog_and_atomic_booking.sql       approval RPC also sets cancelled_at on Cancelled
-- Additive only: no existing column is renamed, retyped or dropped; no existing row is updated or deleted. New rows
-- are only the catalog seeds (9 services, all with online booking OFF and no duration; 90 breed suggestions).
-- appointments.cancelled_at already exists (timestamptz, NULL in every row, never written by the application before).
--
-- NOT IN THIS FILE: row level security for the 14 existing tables. Run 2026-10-20_rls_least_privilege.sql as the next,
-- separately approved step (its header lists the evidence that the backend already uses the service role key).
--
-- SAFETY: PART 0 stops the whole script (nothing changes) if the database differs from the state verified on
-- 2026-10-23 (an object already exists, a column type differs, or a user has two open reset codes). It only reports
-- (NOTICE) official medical records that already exist: there were 0 on 2026-10-23; any record saved before PART D keeps
-- appointment_id NULL and is shown for clinic review. PART Z re-checks the result inside the same transaction, so a
-- failed check also changes nothing. If either stops, save the error text and do not edit the checks to get past them.
-- =====================================================================================================

BEGIN;

-- ---------------------------------------------------------------------------------
-- PART 0: PREFLIGHT (inside the transaction; any failure rolls everything back)
-- ---------------------------------------------------------------------------------
DO $preflight$
DECLARE
  problems text[] := ARRAY[]::text[];
  column_type text;
BEGIN
  -- Column types the functions and foreign keys below rely on
  FOR column_type IN
    SELECT format('%s.%s expected %s', expected.table_name, expected.column_name, expected.udt_name)
    FROM (VALUES
      ('users', 'id', 'uuid'), ('users', 'phone_number', 'text'),
      ('pets', 'id', 'uuid'), ('pets', 'user_id', 'uuid'), ('pets', 'species', 'text'),
      ('appointments', 'id', 'uuid'), ('appointments', 'user_id', 'uuid'), ('appointments', 'pet_id', 'uuid'),
      ('appointments', 'pet_name', 'text'), ('appointments', 'service_type', 'text'), ('appointments', 'status', 'text'),
      ('appointments', 'appointment_date', 'date'), ('appointments', 'appointment_time', 'time'),
      ('appointments', 'estimated_duration_minutes', 'int4'), ('appointments', 'handled_by', 'uuid'),
      ('appointments', 'cancelled_at', 'timestamptz'), ('appointments', 'created_at', 'timestamptz'),
      ('medical_records', 'id', 'uuid'), ('medical_records', 'pet_id', 'uuid'),
      ('password_resets', 'user_id', 'uuid'), ('password_resets', 'used_at', 'timestamptz'),
      ('password_resets', 'attempts', 'int4')
    ) AS expected(table_name, column_name, udt_name)
    LEFT JOIN information_schema.columns AS actual
      ON actual.table_schema = 'public' AND actual.table_name = expected.table_name
     AND actual.column_name = expected.column_name
    WHERE actual.udt_name IS DISTINCT FROM expected.udt_name
  LOOP
    problems := problems || column_type;
  END LOOP;

  -- PART A: none of the profile columns may exist yet (ADD COLUMN IF NOT EXISTS would keep a different type)
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users'
             AND column_name IN ('date_of_birth', 'gender', 'address_line', 'barangay', 'city_municipality', 'province', 'postal_code')) THEN
    problems := problems || 'users already has a profile column: compare it with PART A before continuing'::text;
  END IF;

  -- PART B
  IF to_regclass('public.password_resets_one_open_code_per_user') IS NOT NULL THEN
    problems := problems || 'password_resets_one_open_code_per_user already exists'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM public.password_resets WHERE used_at IS NULL GROUP BY user_id HAVING count(*) > 1) THEN
    problems := problems || 'a user has more than one open password reset code (the unique index would fail)'::text;
  END IF;

  -- PART C, F
  IF to_regclass('public.pet_breed_catalog') IS NOT NULL THEN problems := problems || 'pet_breed_catalog already exists'::text; END IF;
  IF to_regclass('public.owner_pet_weight_reports') IS NOT NULL THEN problems := problems || 'owner_pet_weight_reports already exists'::text; END IF;
  IF to_regclass('public.pethub_service_catalog') IS NOT NULL THEN problems := problems || 'pethub_service_catalog already exists'::text; END IF;

  -- PART D: the link column must not exist yet. Records that already exist keep appointment_id NULL (never backfilled);
  -- the backend shows their pets' completed appointments as "Relationship unresolved" until the clinic reviews them.
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'medical_records' AND column_name = 'appointment_id') THEN
    problems := problems || 'medical_records.appointment_id already exists'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM public.medical_records) THEN
    RAISE NOTICE 'medical_records has % row(s) (0 on 2026-10-23); they stay unlinked and need clinic review',
      (SELECT count(*) FROM public.medical_records);
  END IF;

  -- PART E, F
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
             AND p.proname IN ('cancel_appointment_for_owner', 'create_appointment_if_available', 'update_appointment_status_if_available')) THEN
    problems := problems || 'an appointment function already exists in public: review it before replacing anything'::text;
  END IF;

  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'PetHub reconciliation stopped, nothing was changed: %', array_to_string(problems, '; ');
  END IF;
END
$preflight$;


-- ---------------------------------------------------------------------------------
-- PART A: personal and contact details on users (nullable: existing accounts keep NULL until completed)
-- ---------------------------------------------------------------------------------
ALTER TABLE public.users
  ADD COLUMN date_of_birth date,
  ADD COLUMN gender text,
  ADD COLUMN address_line text,
  ADD COLUMN barangay text,
  ADD COLUMN city_municipality text,
  ADD COLUMN province text,
  ADD COLUMN postal_code text,
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


-- ---------------------------------------------------------------------------------
-- PART B: one open password reset code per user (a parallel request gets 23505, which the backend treats as cooldown)
-- ---------------------------------------------------------------------------------
CREATE UNIQUE INDEX password_resets_one_open_code_per_user
  ON public.password_resets (user_id)
  WHERE used_at IS NULL;


-- ---------------------------------------------------------------------------------
-- PART C: breed suggestions and owner-reported weights (official weights stay in medical_records.weight)
-- ---------------------------------------------------------------------------------
CREATE TABLE public.pet_breed_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  species text NOT NULL CHECK (species IN ('Dog', 'Cat')),
  name varchar(50) NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 50),
  recognition_status text NOT NULL DEFAULT 'unverified'
    CHECK (recognition_status IN ('recognized', 'provisional', 'preliminary', 'experimental', 'developing', 'unverified')),
  source_organization varchar(120),
  source_url text,
  source_reviewed_at date,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX pet_breed_catalog_species_name_ci_key
  ON public.pet_breed_catalog (species, lower(btrim(name)));
CREATE INDEX pet_breed_catalog_active_species_name_idx
  ON public.pet_breed_catalog (species, is_active, name);

INSERT INTO public.pet_breed_catalog (species, name, recognition_status, source_organization, source_url, source_reviewed_at)
SELECT 'Dog', breed, 'recognized', 'American Kennel Club', 'https://www.akc.org/dog-breeds/', DATE '2026-10-22'
FROM unnest(ARRAY[
  'Affenpinscher', 'Afghan Hound', 'Airedale Terrier', 'Akita', 'Alaskan Malamute',
  'American Eskimo Dog', 'American Staffordshire Terrier', 'Australian Cattle Dog',
  'Australian Shepherd', 'Basenji', 'Basset Hound', 'Beagle', 'Belgian Malinois',
  'Bernese Mountain Dog', 'Bichon Frise', 'Border Collie', 'Boston Terrier', 'Boxer',
  'Bulldog', 'Cavalier King Charles Spaniel', 'Chihuahua', 'Cocker Spaniel', 'Collie',
  'Dachshund', 'Doberman Pinscher', 'English Springer Spaniel', 'French Bulldog',
  'German Shepherd Dog', 'German Shorthaired Pointer', 'Golden Retriever', 'Great Dane',
  'Havanese', 'Labrador Retriever', 'Maltese', 'Miniature Schnauzer', 'Papillon',
  'Pembroke Welsh Corgi', 'Pomeranian', 'Poodle', 'Pug', 'Rottweiler', 'Shetland Sheepdog',
  'Shih Tzu', 'Siberian Husky', 'Staffordshire Bull Terrier', 'Weimaraner',
  'West Highland White Terrier', 'Yorkshire Terrier'
]) AS breeds(breed)
UNION ALL
SELECT 'Cat', breed, 'recognized', 'Cat Fanciers'' Association', 'https://cfa.org/breeds/', DATE '2026-10-22'
FROM unnest(ARRAY[
  'Abyssinian', 'American Bobtail', 'American Curl', 'American Shorthair', 'American Wirehair',
  'Balinese', 'Bengal', 'Birman', 'Bombay', 'British Shorthair', 'Burmese', 'Burmilla',
  'Chartreux', 'Cornish Rex', 'Devon Rex', 'Egyptian Mau', 'Exotic', 'Havana Brown',
  'Himalayan', 'Japanese Bobtail', 'Korat', 'LaPerm', 'Maine Coon', 'Manx', 'Norwegian Forest Cat',
  'Ocicat', 'Oriental', 'Persian', 'Ragdoll', 'Russian Blue', 'Scottish Fold', 'Selkirk Rex',
  'Siamese', 'Siberian', 'Singapura', 'Somali', 'Sphynx', 'Tonkinese', 'Turkish Angora', 'Turkish Van'
]) AS breeds(breed);

-- Common local descriptions used by existing PetHub profiles, not presented as officially recognized
INSERT INTO public.pet_breed_catalog (species, name, recognition_status, source_organization, source_reviewed_at)
VALUES
  ('Dog', 'Aspin', 'unverified', 'PetHub local descriptor', DATE '2026-10-22'),
  ('Cat', 'Puspin', 'unverified', 'PetHub local descriptor', DATE '2026-10-22');

CREATE TABLE public.owner_pet_weight_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pet_id uuid NOT NULL REFERENCES public.pets(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  weight_kg numeric(7, 2) NOT NULL CHECK (weight_kg > 0),
  source text NOT NULL DEFAULT 'owner_reported' CHECK (source = 'owner_reported'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX owner_pet_weight_reports_pet_recorded_idx
  ON public.owner_pet_weight_reports (pet_id, recorded_at DESC);
CREATE INDEX owner_pet_weight_reports_user_pet_idx
  ON public.owner_pet_weight_reports (user_id, pet_id, recorded_at DESC);

ALTER TABLE public.pet_breed_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.owner_pet_weight_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pet_breed_catalog, public.owner_pet_weight_reports FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.pet_breed_catalog, public.owner_pet_weight_reports TO service_role;

COMMENT ON TABLE public.pet_breed_catalog IS 'Clinic-maintained breed suggestions. Existing pets keep their text breed when an entry is deactivated.';
COMMENT ON TABLE public.owner_pet_weight_reports IS 'Append-only owner-reported weight snapshots. These are distinct from clinic medical_records.weight.';


-- ---------------------------------------------------------------------------------
-- PART D: optional explicit link from an official medical record to the completed appointment that produced it
-- (walk-in / standalone records keep NULL; at most one record per linked appointment)
-- ---------------------------------------------------------------------------------
ALTER TABLE public.medical_records
  ADD COLUMN appointment_id uuid;

ALTER TABLE public.medical_records
  ADD CONSTRAINT medical_records_appointment_id_fkey
  FOREIGN KEY (appointment_id) REFERENCES public.appointments(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX medical_records_one_per_appointment_key
  ON public.medical_records (appointment_id)
  WHERE appointment_id IS NOT NULL;

COMMENT ON COLUMN public.medical_records.appointment_id IS
  'Optional explicit link to the completed appointment that produced this official record. NULL for standalone (walk-in) records.';


-- ---------------------------------------------------------------------------------
-- PART E: owner cancellation, checked against the database clock in the same conditional UPDATE
-- Only Pending/Approved -> Cancelled, at least 2 hours before the Asia/Manila start; never deletes a row.
-- ---------------------------------------------------------------------------------
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
  SET status = 'Cancelled',
      cancelled_at = statement_timestamp()
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


-- ---------------------------------------------------------------------------------
-- PART F: persisted service catalog (all services seeded with online booking OFF and no duration) and
-- database-atomic booking / approval that share one per-date lock across every backend instance
-- ---------------------------------------------------------------------------------
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
  SET status = p_status,
      handled_by = p_handled_by,
      cancelled_at = CASE WHEN p_status = 'Cancelled' THEN statement_timestamp() ELSE cancelled_at END
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


-- ---------------------------------------------------------------------------------
-- PART Z: POST-CHECKS (still inside the transaction; any failure rolls everything back)
-- ---------------------------------------------------------------------------------
DO $postcheck$
DECLARE
  problems text[] := ARRAY[]::text[];
  fn regprocedure;
  tbl regclass;
BEGIN
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND is_nullable = 'YES'
      AND column_name IN ('date_of_birth', 'gender', 'address_line', 'barangay', 'city_municipality', 'province', 'postal_code')) <> 7 THEN
    problems := problems || 'users profile columns'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM public.users WHERE date_of_birth IS NOT NULL OR gender IS NOT NULL OR address_line IS NOT NULL
             OR barangay IS NOT NULL OR city_municipality IS NOT NULL OR province IS NOT NULL OR postal_code IS NOT NULL) THEN
    problems := problems || 'existing accounts must keep NULL profile details'::text;
  END IF;
  IF to_regclass('public.password_resets_one_open_code_per_user') IS NULL THEN problems := problems || 'password reset index'::text; END IF;
  IF (SELECT count(*) FROM public.pet_breed_catalog) <> 90
     OR (SELECT count(*) FROM public.pet_breed_catalog WHERE recognition_status = 'unverified') <> 2 THEN
    problems := problems || 'breed catalog seed (expected 48 dog + 40 cat recognized, 2 unverified local)'::text;
  END IF;
  IF (SELECT count(*) FROM public.pethub_service_catalog) <> 9
     OR EXISTS (SELECT 1 FROM public.pethub_service_catalog WHERE online_booking_enabled OR duration_minutes IS NOT NULL) THEN
    problems := problems || 'service catalog seed (expected 9 services, booking off, no durations)'::text;
  END IF;
  IF to_regclass('public.medical_records_one_per_appointment_key') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'medical_records_appointment_id_fkey' AND conrelid = 'public.medical_records'::regclass) THEN
    problems := problems || 'medical record appointment link'::text;
  END IF;

  FOREACH tbl IN ARRAY ARRAY['public.pet_breed_catalog', 'public.owner_pet_weight_reports', 'public.pethub_service_catalog']::regclass[] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = tbl)
       OR has_table_privilege('anon', tbl, 'SELECT') OR has_table_privilege('authenticated', tbl, 'SELECT')
       OR NOT has_table_privilege('service_role', tbl, 'SELECT') THEN
      problems := problems || format('%s: RLS on, API roles closed, service_role open', tbl);
    END IF;
  END LOOP;

  FOREACH fn IN ARRAY ARRAY[
    'public.cancel_appointment_for_owner(uuid, uuid, text)',
    'public.create_appointment_if_available(uuid, uuid, uuid, text, text, integer, date, time without time zone)',
    'public.update_appointment_status_if_available(uuid, text, uuid, text)'
  ]::regprocedure[] LOOP
    IF (SELECT prosecdef FROM pg_proc WHERE oid = fn)
       OR has_function_privilege('anon', fn, 'EXECUTE') OR has_function_privilege('authenticated', fn, 'EXECUTE')
       OR NOT has_function_privilege('service_role', fn, 'EXECUTE') THEN
      problems := problems || format('%s: SECURITY INVOKER, service_role only', fn);
    END IF;
  END LOOP;

  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'PetHub reconciliation post-check failed, nothing was changed: %', array_to_string(problems, '; ');
  END IF;
END
$postcheck$;

COMMIT;

-- Lets the Supabase API (PostgREST) see the new columns, tables and functions at once
NOTIFY pgrst, 'reload schema';


-- ---------------------------------------------------------------------------------
-- AFTER COMMIT (read-only, run each on its own; the SQL Editor shows only the last result)
-- ---------------------------------------------------------------------------------
-- 1. Expect 0 rows: nothing in public that the API roles can execute
--    SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
-- 2. Smoke test with real accounts the clinic controls (not customer accounts): register + verify a new account;
--    owner: My Pets (add a pet with a listed breed), pet history, Health records, Appointments (services listed,
--    online booking shown as closed); admin: Appointment Management loads, approve/cancel a TEST appointment,
--    Services settings load, Breed catalog loads.
-- 3. Then, as the next separately approved step: 2026-10-20_rls_least_privilege.sql.


-- ---------------------------------------------------------------------------------
-- RECOVERY (not part of the migration)
-- ---------------------------------------------------------------------------------
-- If the script stops, PostgreSQL rolls the whole transaction back: nothing above is applied. Keep the error text.
-- After a successful run, prefer forward fixes. Once real data exists, do NOT drop these objects: dropping the profile
-- columns, catalogs, weight reports or appointment links deletes customer/clinic data. Roll the backend code back
-- instead (the additive objects are harmless to older code). Only on a database where none of these objects have been
-- used yet, and after exporting them, an approved operator may reverse this file in this order:
--   BEGIN;
--   DROP FUNCTION public.update_appointment_status_if_available(uuid, text, uuid, text);
--   DROP FUNCTION public.create_appointment_if_available(uuid, uuid, uuid, text, text, integer, date, time without time zone);
--   DROP TABLE public.pethub_service_catalog;
--   DROP FUNCTION public.cancel_appointment_for_owner(uuid, uuid, text);
--   DROP INDEX public.medical_records_one_per_appointment_key;
--   ALTER TABLE public.medical_records DROP CONSTRAINT medical_records_appointment_id_fkey, DROP COLUMN appointment_id;
--   DROP TABLE public.owner_pet_weight_reports;
--   DROP TABLE public.pet_breed_catalog;
--   DROP INDEX public.password_resets_one_open_code_per_user;
--   ALTER TABLE public.users DROP COLUMN date_of_birth, DROP COLUMN gender, DROP COLUMN address_line, DROP COLUMN barangay,
--     DROP COLUMN city_municipality, DROP COLUMN province, DROP COLUMN postal_code;
--   COMMIT;
--   NOTIFY pgrst, 'reload schema';
-- appointments.cancelled_at values written by PART E/F are ordinary data in a pre-existing column; they stay.
