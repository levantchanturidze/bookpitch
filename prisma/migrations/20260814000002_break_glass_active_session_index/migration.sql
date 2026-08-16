-- DB-enforced uniqueness for active break-glass sessions.
--
-- Without this index, the application-level "one active session at a time"
-- check in startBreakGlass (findFirst + create inside a transaction) is
-- vulnerable to a READ COMMITTED TOCTOU race: two concurrent transactions
-- can both read NULL for the existing-session check, then both create a
-- session, leaving two active sessions for the same actor.
--
-- A non-unique index idx_break_glass_sessions_actor_active already exists
-- from migration 20260728130000_rbac_platform_sessions. We drop it and
-- replace it with a UNIQUE variant so the second concurrent INSERT fails
-- with 23505 (unique_violation), which the application catches and surfaces
-- as ConflictError regardless of which race path (app-level or DB-level)
-- resolved the conflict.
--
-- The WHERE predicate mirrors the application query:
--   ended_at IS NULL  →  only one *active* (not ended) session per actor.
-- Ended or expired sessions are not constrained — a user may have unlimited
-- historical sessions.
--
-- Rollback:
--   DROP INDEX IF EXISTS idx_break_glass_sessions_actor_active;
--   CREATE INDEX idx_break_glass_sessions_actor_active
--     ON break_glass_sessions (actor_user_id) WHERE ended_at IS NULL;

DROP INDEX IF EXISTS idx_break_glass_sessions_actor_active;

CREATE UNIQUE INDEX idx_break_glass_sessions_actor_active
  ON break_glass_sessions (actor_user_id)
  WHERE ended_at IS NULL;
