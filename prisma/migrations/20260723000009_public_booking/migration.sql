-- Public booking widget. Each Location gets an optional short slug so
-- customers can visit /book/<slug> without any account.
--
-- Slug is unique globally (not per-org) so URLs stay short. Nullable
-- because opt-in — orgs that don't want a public surface leave it
-- unset.

ALTER TABLE "locations"
    ADD COLUMN "public_slug" TEXT;

CREATE UNIQUE INDEX "idx_locations_public_slug"
    ON "locations" ("public_slug")
    WHERE "public_slug" IS NOT NULL;
