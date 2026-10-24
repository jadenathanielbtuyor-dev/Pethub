-- =====================================================================================================
-- PetHub: remove the last password stored before hashing; that account must set a new one with "Forgot password?"
-- Prepared 2026-10-24. Run once, as ONE script, AFTER the backend that refuses non-scrypt passwords is deployed.
--
-- Registration and password reset have stored salted scrypt hashes since 2026-10-17, and older values were upgraded
-- when their owners logged in. On 2026-10-24 one verified customer account (no pets, no appointments, last active
-- 2026-10-18) still held a plaintext value. Hashing that value in place would keep a password that was readable in the
-- database valid, so instead the stored value is replaced, inside the database, by a random "reset-required$" marker:
-- the plaintext is never selected, printed or sent anywhere, the marker matches no password (the backend accepts
-- only scrypt hashes, and the marker is random, so even older code could not match it), and the owner sets a new
-- password through the existing emailed-code reset, which stores a scrypt hash. An activity_logs row records why.
--
-- Changes only users.password of rows that are neither scrypt hashes nor markers already; nothing else.
-- =====================================================================================================

BEGIN;

-- PART 0: stop, changing nothing, unless the database is in the expected state
DO $preflight$
DECLARE
  legacy_count integer;
BEGIN
  SELECT count(*) INTO legacy_count FROM public.users
  WHERE password NOT LIKE 'scrypt$%' AND password NOT LIKE 'reset-required$%';
  IF legacy_count > 1 THEN
    RAISE EXCEPTION 'PetHub legacy password preflight failed: % accounts hold a non-hashed password (1 expected), nothing was changed', legacy_count;
  END IF;
END
$preflight$;

-- PART A: an audit record for each affected account (no secret in it), then the replacement
INSERT INTO public.activity_logs (actor_id, user_id, target_table, target_id, action, details)
SELECT NULL, id, 'users', id, 'password_reset_required',
       'The stored password was saved before passwords were hashed, so it was removed. Use Forgot password to set a new one.'
FROM public.users
WHERE password NOT LIKE 'scrypt$%' AND password NOT LIKE 'reset-required$%';

UPDATE public.users
SET password = 'reset-required$' || replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
WHERE password NOT LIKE 'scrypt$%' AND password NOT LIKE 'reset-required$%';

-- PART Z: verify before committing
DO $postcheck$
BEGIN
  IF EXISTS (SELECT 1 FROM public.users WHERE password NOT LIKE 'scrypt$%' AND password NOT LIKE 'reset-required$%') THEN
    RAISE EXCEPTION 'PetHub legacy password post-check failed: a non-hashed password remains, nothing was changed';
  END IF;
END
$postcheck$;

COMMIT;

-- No rollback: the removed value was the security problem. The account owner restores access with Forgot password.
