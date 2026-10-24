-- PetHub: stop auto-granting the public API roles on FUTURE objects that postgres creates in public.
-- Prepared 2026-10-24. Existing objects are not touched. service_role keeps its default grants.
-- Supabase's defaults give anon and authenticated every privilege on each new table, sequence and function, so a table
-- created later without RLS would be readable and writable with the public key at once. PetHub's browser never talks to
-- Supabase, so the API roles need nothing. supabase_admin's own default entries cannot be changed by postgres (not a
-- member); every current public object is owned by postgres.
BEGIN;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

DO $postcheck$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_default_acl d, aclexplode(d.defaclacl) AS acl
    WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 'public'::regnamespace
      AND acl.grantee IN ('anon'::regrole, 'authenticated'::regrole)
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_default_acl d, aclexplode(d.defaclacl) AS acl
    WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 'public'::regnamespace AND d.defaclobjtype = 'r'
      AND acl.grantee = 'service_role'::regrole AND acl.privilege_type = 'SELECT'
  ) THEN
    RAISE EXCEPTION 'PetHub default privileges post-check failed, nothing was changed';
  END IF;
END
$postcheck$;

COMMIT;

-- Check (expect no anon/authenticated in any postgres row):
--   SELECT defaclobjtype, defaclacl FROM pg_default_acl WHERE defaclrole = 'postgres'::regrole;
-- Rollback (restores the 2026-10-24 defaults):
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated;
