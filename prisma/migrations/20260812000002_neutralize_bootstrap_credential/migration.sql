-- Neutralize the bootstrap credential committed to migration history.
--
-- Context: Migrations 20260810000002, 000004, 000005, and 000007 embedded
-- a plaintext bootstrap password and its Argon2id hash in SQL. The password
-- was manually rotated in production, but any environment that runs a
-- fresh migration sequence arrives with the known bootstrap credential active.
--
-- Condition: Only the exact Argon2id hash committed in those migrations
-- triggers this corrective action. Any other hash — including a legitimately
-- rotated credential — is left completely untouched.
--
-- Action on match:
--   1. Set password_hash = NULL (credential-based sign-in requires a non-NULL hash).
--   2. Bump session_version (invalidates all JWT sessions for the account).
--   3. Delete outstanding unconsumed reauth grants (prevents privilege escalation
--      via a pre-authenticated reauth window).
--
-- After this migration:
--   • Clean installs: no usable privileged credential remains.
--   • Production (already rotated): no-op. Zero rows affected.
--   • New environments must use scripts/platform-bootstrap.ts to set a new
--     credential explicitly, which writes an audit record.
--
-- Security note: Git history is not rewritten. Rotation + this migration
-- neutralize the historical disclosure; the hash in history is cryptographically
-- committed and its disclosure risk is addressed by making it non-matching in
-- every live database.

DO $$
DECLARE
  affected_ids uuid[];
  compromised_hash text := '$argon2id$v=19$m=19456,t=2,p=1$sWwZ73KLKQZ4ed4nXHRCbg$kgQKBGOj3L13oFwS053u+djbVc0CwUBtiNhYGuS2myM';
BEGIN
  -- Collect IDs of platform accounts whose password_hash still matches the
  -- compromised bootstrap value.
  SELECT array_agg(id)
    INTO affected_ids
    FROM app_users
   WHERE password_hash = compromised_hash
     AND platform_role_id IS NOT NULL;

  -- Nothing to do if no affected rows exist (expected in production after rotation).
  IF affected_ids IS NULL OR array_length(affected_ids, 1) = 0 THEN
    RETURN;
  END IF;

  -- Clear the compromised credential and invalidate sessions.
  UPDATE app_users
     SET password_hash   = NULL,
         session_version = session_version + 1
   WHERE id = ANY(affected_ids);

  -- Delete outstanding unconsumed reauth grants for affected users.
  DELETE FROM platform_reauth_grant
   WHERE user_id = ANY(affected_ids)
     AND consumed_at IS NULL;

  -- Delete Auth.js database sessions for affected users when the table exists.
  -- session_version bump above is the primary JWT-based invalidation mechanism.
  -- The sessions table only exists in database-session Auth.js deployments;
  -- JWT-only deployments omit it. Guard with to_regclass() so clean installs
  -- succeed regardless of Auth.js strategy. Dynamic EXECUTE is required because
  -- PL/pgSQL validates table names at parse time, not at runtime — a static
  -- DELETE FROM sessions would raise 42P01 on installs without the table.
  IF to_regclass('public.sessions') IS NOT NULL THEN
    EXECUTE 'DELETE FROM sessions WHERE "userId"::uuid = ANY($1)'
      USING affected_ids;
  END IF;

  RAISE NOTICE 'neutralize_bootstrap_credential: cleared % account(s)', array_length(affected_ids, 1);
END $$;
