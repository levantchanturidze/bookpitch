-- Per-org feature flags. JSONB so a new flag is a code change, not a
-- migration. Flag names live in lib/features.ts; anything not in the
-- default map is treated as "off" so we can never accidentally roll out
-- a half-built feature.

ALTER TABLE "organizations"
    ADD COLUMN "features" JSONB NOT NULL DEFAULT '{}'::jsonb;
