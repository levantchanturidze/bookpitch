-- Add ISO 4217 currency code to organizations.
-- Default 'GEL' keeps existing rows correct; no data migration needed.

ALTER TABLE organizations ADD COLUMN currency varchar(3) NOT NULL DEFAULT 'GEL';
