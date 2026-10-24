-- =====================================================================================================
-- PetHub: server-side sign-in sessions, so logging out and resetting a password end a session before it expires
-- Prepared 2026-10-24. Run once, as ONE script.
--
--   user_sessions   One row per successful login (POST /auth/login). The signed token carries the row id; every
--                   signed-in request checks that the row belongs to the token's account, is not revoked and has not
--                   expired. POST /auth/logout revokes the session it was sent with; a completed password reset
--                   revokes every open session of that account. Rows keep no token, IP address or device: only whose
--                   session it is and when it started, expires and ended.
--
-- Additive only: no existing table, row, function or privilege changes. Tokens issued before the code that uses this
-- table carry no session id and are refused by that code, so everyone signs in once more after that deployment.
-- New tables get privileges for anon/authenticated through this project's default privileges, so PART B revokes them;
-- RLS is on with no policies, like every other PetHub table (only the backend, with the service role, reads it).
-- =====================================================================================================

BEGIN;

-- PART 0: stop, changing nothing, unless the database is in the expected state
DO $preflight$
DECLARE
  problems text[] := ARRAY[]::text[];
BEGIN
  IF to_regclass('public.user_sessions') IS NOT NULL THEN
    problems := problems || 'public.user_sessions already exists (has this file already run?)'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'id' AND data_type = 'uuid') THEN
    problems := problems || 'public.users.id (uuid) is missing'::text;
  END IF;
  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'PetHub user_sessions preflight failed (%), nothing was changed', array_to_string(problems, ', ');
  END IF;
END
$preflight$;

-- PART A: the sessions table
CREATE TABLE public.user_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text,
  CONSTRAINT user_sessions_expiry_after_start CHECK (expires_at > created_at),
  CONSTRAINT user_sessions_revoked_reason_option CHECK (revoked_reason IN ('logout', 'password_reset')),
  CONSTRAINT user_sessions_revocation_complete CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);

-- A password reset ends every open session of one account
CREATE INDEX user_sessions_user_id_open_idx ON public.user_sessions (user_id) WHERE revoked_at IS NULL;

-- PART B: backend only (service role), like every other PetHub table
ALTER TABLE public.user_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.user_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_sessions TO service_role;

-- PART Z: verify before committing
DO $postcheck$
DECLARE
  problems text[] := ARRAY[]::text[];
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.user_sessions'::regclass) THEN
    problems := problems || 'RLS is off'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.role_table_grants
             WHERE table_schema = 'public' AND table_name = 'user_sessions' AND grantee IN ('PUBLIC', 'anon', 'authenticated')) THEN
    problems := problems || 'anon, authenticated or PUBLIC still has a privilege'::text;
  END IF;
  IF (SELECT count(*) FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'user_sessions' AND grantee = 'service_role'
        AND privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')) <> 4 THEN
    problems := problems || 'service_role privileges'::text;
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.user_sessions'::regclass AND convalidated AND conname IN (
       'user_sessions_expiry_after_start', 'user_sessions_revoked_reason_option', 'user_sessions_revocation_complete')) <> 3 THEN
    problems := problems || 'check constraints'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'user_sessions_user_id_open_idx') THEN
    problems := problems || 'index'::text;
  END IF;
  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'PetHub user_sessions post-check failed (%), nothing was changed', array_to_string(problems, ', ');
  END IF;
END
$postcheck$;

COMMIT;

-- ROLLBACK (not part of the change; only after removing the code that uses it, otherwise nobody can sign in):
--   DROP TABLE public.user_sessions;
