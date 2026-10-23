-- PetHub: persisted breed options and owner-reported weight history.
-- Prepared 2026-10-22. NOT APPLIED (verified 2026-10-23). Included unchanged in 2026-10-23_reconcile_live_schema.sql:
-- run that file instead of this one.
-- This is additive. It does not alter pets.breed or medical_records.weight and does not rewrite existing records.
-- The initial breed rows are a reviewed selection from AKC / CFA lists, not a universal or exhaustive registry.
-- Owner-entered weights are separate, append-only rows with their own source and timestamp.

BEGIN;

CREATE TABLE IF NOT EXISTS public.pet_breed_catalog (
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

CREATE UNIQUE INDEX IF NOT EXISTS pet_breed_catalog_species_name_ci_key
  ON public.pet_breed_catalog (species, lower(btrim(name)));
CREATE INDEX IF NOT EXISTS pet_breed_catalog_active_species_name_idx
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
]) AS breeds(breed)
ON CONFLICT DO NOTHING;

-- Retain common local descriptions used by existing PetHub profiles without presenting them as officially recognized.
INSERT INTO public.pet_breed_catalog (species, name, recognition_status, source_organization, source_reviewed_at)
VALUES
  ('Dog', 'Aspin', 'unverified', 'PetHub local descriptor', DATE '2026-10-22'),
  ('Cat', 'Puspin', 'unverified', 'PetHub local descriptor', DATE '2026-10-22')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS public.owner_pet_weight_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pet_id uuid NOT NULL REFERENCES public.pets(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  weight_kg numeric(7, 2) NOT NULL CHECK (weight_kg > 0),
  source text NOT NULL DEFAULT 'owner_reported' CHECK (source = 'owner_reported'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS owner_pet_weight_reports_pet_recorded_idx
  ON public.owner_pet_weight_reports (pet_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS owner_pet_weight_reports_user_pet_idx
  ON public.owner_pet_weight_reports (user_id, pet_id, recorded_at DESC);

ALTER TABLE public.pet_breed_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.owner_pet_weight_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pet_breed_catalog, public.owner_pet_weight_reports FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.pet_breed_catalog, public.owner_pet_weight_reports TO service_role;

COMMENT ON TABLE public.pet_breed_catalog IS 'Clinic-maintained breed suggestions. Existing pets keep their text breed when an entry is deactivated.';
COMMENT ON TABLE public.owner_pet_weight_reports IS 'Append-only owner-reported weight snapshots. These are distinct from clinic medical_records.weight.';

COMMIT;
NOTIFY pgrst, 'reload schema';
