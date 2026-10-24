-- =====================================================================================================
-- PetHub: the database enforces the closed value sets the backend's logic depends on
-- Prepared 2026-10-24. Run once, as ONE script.
--
--   users.role           'user' | 'admin'      admin access is granted only for role = 'admin' (routes/admin.js) and
--                                              PUT /admin/dashboard/user-role accepts only these two (adminService.js)
--   appointments.status  'Pending' | 'Approved' | 'Completed' | 'Cancelled'
--                                              VALID_APPOINTMENT_STATUSES (constants/appointments.js); the status
--                                              transitions, schedule overlap checks and the three appointment functions
--                                              recognise only these
--   pets.species         'Dog' | 'Cat'         the clinic serves dogs and cats only (validators/petsValidator.js,
--                                              SERVICE_SPECIES in constants/services.js); service eligibility compares
--                                              pets.species with pethub_service_catalog.species
-- A value outside these sets, written by any path (SQL Editor, a script, a future bug), would silently break admin
-- access, the appointment workflow or booking eligibility; the constraint refuses it instead.
-- Verified 2026-10-24 before preparing: every existing row already satisfies all three (users: 4 user + 1 admin;
-- appointments: 2 Completed; pets: 3 Dog), and the backend writes only these values (all 305 tests, recorded).
-- Additive only: no row changes. PART 0 stops everything if any existing row would violate a constraint.
-- =====================================================================================================

BEGIN;

DO $preflight$
DECLARE
  problems text[] := ARRAY[]::text[];
BEGIN
  IF EXISTS (SELECT 1 FROM public.users WHERE role IS NULL OR role NOT IN ('user', 'admin')) THEN
    problems := problems || 'users.role has a value outside user/admin'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM public.appointments WHERE status IS NULL OR status NOT IN ('Pending', 'Approved', 'Completed', 'Cancelled')) THEN
    problems := problems || 'appointments.status has a value outside Pending/Approved/Completed/Cancelled'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM public.pets WHERE species IS NULL OR species NOT IN ('Dog', 'Cat')) THEN
    problems := problems || 'pets.species has a value outside Dog/Cat'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname IN ('users_role_option', 'appointments_status_option', 'pets_species_option')) THEN
    problems := problems || 'a constraint with one of these names already exists'::text;
  END IF;
  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'PetHub value checks stopped, nothing was changed: %', array_to_string(problems, '; ');
  END IF;
END
$preflight$;

ALTER TABLE public.users ADD CONSTRAINT users_role_option CHECK (role IN ('user', 'admin'));
ALTER TABLE public.appointments ADD CONSTRAINT appointments_status_option CHECK (status IN ('Pending', 'Approved', 'Completed', 'Cancelled'));
ALTER TABLE public.pets ADD CONSTRAINT pets_species_option CHECK (species IN ('Dog', 'Cat'));

DO $postcheck$
BEGIN
  IF (SELECT count(*) FROM pg_constraint WHERE contype = 'c' AND convalidated
      AND conname IN ('users_role_option', 'appointments_status_option', 'pets_species_option')) <> 3 THEN
    RAISE EXCEPTION 'PetHub value checks post-check failed, nothing was changed';
  END IF;
END
$postcheck$;

COMMIT;

-- ROLLBACK (not part of the change):
--   ALTER TABLE public.users DROP CONSTRAINT users_role_option;
--   ALTER TABLE public.appointments DROP CONSTRAINT appointments_status_option;
--   ALTER TABLE public.pets DROP CONSTRAINT pets_species_option;
