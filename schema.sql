-- =============================================================================
-- Clinic & Salon Schedule Manager — Production Database Schema (PostgreSQL)
-- =============================================================================
-- Derived from the AI Studio prototype's src/types.ts, promoted to a real,
-- multi-tenant, auditable schema.
--
-- Key promotions vs. the prototype:
--   * localStorage  ->  PostgreSQL (durable, multi-device, multi-user)
--   * "role dropdown" -> real memberships + server-enforced RBAC (+ RLS)
--   * single implicit business -> multi-tenant (organization -> locations)
--   * fake STRIPE_TX -> real payments table linked to a gateway transaction
--   * health fields (allergies, conditions) -> flagged sensitive + audited
--
-- Conventions: UUID primary keys, snake_case, timestamptz everywhere,
-- soft-scoping by organization_id on every tenant-owned row.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;      -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS btree_gist;    -- exclusion constraint for anti-double-booking

-- -----------------------------------------------------------------------------
-- ENUMS
-- -----------------------------------------------------------------------------
CREATE TYPE location_type      AS ENUM ('clinic', 'salon');
CREATE TYPE user_role          AS ENUM ('owner', 'practitioner', 'receptionist');
CREATE TYPE appointment_status AS ENUM ('pending', 'confirmed', 'completed', 'cancelled');
CREATE TYPE payment_status     AS ENUM ('unpaid', 'paid', 'refunding', 'refunded');
CREATE TYPE payment_method     AS ENUM ('card', 'apple_pay', 'google_pay', 'cash');
CREATE TYPE message_channel    AS ENUM ('sms', 'email');
CREATE TYPE message_state      AS ENUM ('queued', 'sent', 'failed', 'delivered');

-- =============================================================================
-- TENANCY
-- =============================================================================

-- Top-level account. In the prototype this is the "Grand Medical & Aurora Spa Group".
CREATE TABLE organizations (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name         text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Each physical business. An org can own several; each is clinic OR salon.
-- This is what the prototype's clinic/salon "mode" toggle becomes.
CREATE TABLE locations (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    type              location_type NOT NULL,
    name              text NOT NULL,          -- "Grand Medical Suite", "Aurora Salon & Spa"
    timezone          text NOT NULL DEFAULT 'Asia/Tbilisi',
    tax_rate          numeric(5,4) NOT NULL DEFAULT 0,  -- e.g. 0.0000 (set per jurisdiction)
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_locations_org ON locations(organization_id);

-- =============================================================================
-- IDENTITY & ACCESS
-- =============================================================================
-- app_users may be backed by an external auth provider (Supabase Auth / Clerk /
-- Auth.js). Store the provider subject id, never a password here.
CREATE TABLE app_users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_provider text NOT NULL,               -- 'supabase' | 'clerk' | ...
    auth_subject  text NOT NULL,               -- provider user id
    email         citext NOT NULL,
    full_name     text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (auth_provider, auth_subject)
);

-- A user's role WITHIN an organization. RBAC is enforced from here, server-side.
CREATE TABLE memberships (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id          uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    role             user_role NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, user_id)
);
CREATE INDEX idx_memberships_user ON memberships(user_id);

-- =============================================================================
-- STAFF (practitioners / stylists)
-- =============================================================================
CREATE TABLE staff (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    location_id      uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    user_id          uuid REFERENCES app_users(id) ON DELETE SET NULL, -- if staff also logs in
    name             text NOT NULL,
    role_title       text NOT NULL,            -- 'Senior Cardiologist', 'Lead Hair Stylist'
    specialty        text,
    email            citext,
    phone            text,
    avatar_url       text,
    calendar_color   text,                     -- UI color from prototype
    rating           numeric(3,2),             -- display metric; keep or drop
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_staff_location ON staff(location_id);

-- Weekly availability windows. Prototype had days[] + "09:00 - 17:00" as a string;
-- normalized here so the booker can validate against real windows.
CREATE TABLE staff_availability (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id     uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    weekday      smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0=Sunday
    start_time   time NOT NULL,
    end_time     time NOT NULL,
    CHECK (end_time > start_time)
);
CREATE INDEX idx_availability_staff ON staff_availability(staff_id);

-- =============================================================================
-- SERVICE CATALOG
-- =============================================================================
-- Prototype hardcoded MEDICAL_SERVICES / SALON_SERVICES; now per-location.
CREATE TABLE services (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    location_id      uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    name             text NOT NULL,
    category         text,
    price            numeric(10,2) NOT NULL,
    duration_minutes integer NOT NULL CHECK (duration_minutes > 0),
    is_active        boolean NOT NULL DEFAULT true,
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_services_location ON services(location_id);

-- =============================================================================
-- CUSTOMERS (patients / clients)  -- CONTAINS SENSITIVE HEALTH DATA
-- =============================================================================
-- The prototype shares one customer across clinic & salon (Sarah Jenkins), so
-- customers are scoped to the ORGANIZATION, not a single location.
--
-- COMPLIANCE: allergies, clinical_notes and medical history are special-category
-- (health) data under Georgia's data-protection law and GDPR. Recommended:
--   * encrypt these columns at rest (pgcrypto column encryption or app-layer),
--   * log every read/write to audit_log,
--   * capture explicit consent (consent_at / consent_version).
CREATE TABLE customers (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name             text NOT NULL,
    email            citext,
    phone            text,
    dob              date,
    gender           text,
    avatar_url       text,
    joined_date      date NOT NULL DEFAULT current_date,
    -- --- sensitive (health) fields: treat differently from the rest ---
    allergies        text,   -- ENCRYPT
    clinical_notes   text,   -- ENCRYPT  (prototype "notes": conditions, meds, sensitivities)
    consent_at       timestamptz,
    consent_version  text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_customers_org ON customers(organization_id);

-- Prototype stored history as a string[]; normalized into rows.
CREATE TABLE treatment_history (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id  uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    label        text NOT NULL,           -- 'Annual Physical (Jan 2026)'
    occurred_on  date,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_history_customer ON treatment_history(customer_id);

-- =============================================================================
-- APPOINTMENTS  (the booking core)
-- =============================================================================
CREATE TABLE appointments (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    location_id      uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    customer_id      uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    staff_id         uuid NOT NULL REFERENCES staff(id)     ON DELETE RESTRICT,
    service_id       uuid REFERENCES services(id) ON DELETE SET NULL,
    -- computed time window (generated from starts_at + duration)
    starts_at        timestamptz NOT NULL,
    ends_at          timestamptz NOT NULL,
    service_name     text NOT NULL,        -- snapshot (price/name at booking time)
    price            numeric(10,2) NOT NULL,
    status           appointment_status NOT NULL DEFAULT 'pending',
    payment_status   payment_status     NOT NULL DEFAULT 'unpaid',
    notes            text,
    created_by       uuid REFERENCES app_users(id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CHECK (ends_at > starts_at)
);
CREATE INDEX idx_appt_location_day ON appointments(location_id, starts_at);
CREATE INDEX idx_appt_staff        ON appointments(staff_id, starts_at);
CREATE INDEX idx_appt_customer     ON appointments(customer_id);

-- ANTI-DOUBLE-BOOKING: a staff member cannot have two overlapping, non-cancelled
-- appointments. Enforced by the database, not just the UI.
ALTER TABLE appointments
    ADD CONSTRAINT no_staff_double_booking
    EXCLUDE USING gist (
        staff_id WITH =,
        tstzrange(starts_at, ends_at) WITH &&
    ) WHERE (status <> 'cancelled');

-- =============================================================================
-- PAYMENTS  (real gateway transactions — replaces the fake STRIPE_TX_ token)
-- =============================================================================
-- Store ONLY gateway references, never card data (keeps PCI scope minimal via a
-- hosted payment page: BoG iPay or TBC E-Commerce).
CREATE TABLE payments (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    appointment_id   uuid REFERENCES appointments(id) ON DELETE SET NULL,
    method           payment_method NOT NULL,
    gateway          text,                    -- 'bog_ipay' | 'tbc_ecommerce' | 'cash'
    gateway_txn_id   text,                    -- real transaction id from the bank
    amount           numeric(10,2) NOT NULL,
    tax_amount       numeric(10,2) NOT NULL DEFAULT 0,
    currency         text NOT NULL DEFAULT 'GEL',
    status           payment_status NOT NULL DEFAULT 'unpaid',
    paid_at          timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_payments_appt ON payments(appointment_id);

-- =============================================================================
-- MESSAGING (reminders) & NOTIFICATIONS
-- =============================================================================
CREATE TABLE message_templates (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    channel          message_channel NOT NULL,
    body             text NOT NULL,           -- supports {PatientName}, {StaffName}, {Date}, {Time}...
    updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Actual send log (replaces the prototype's fake "Dispatch -> Sent").
CREATE TABLE message_log (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    appointment_id   uuid REFERENCES appointments(id) ON DELETE SET NULL,
    channel          message_channel NOT NULL,
    to_address       text NOT NULL,           -- phone or email
    body             text NOT NULL,
    provider_msg_id  text,                    -- id returned by SMS/email provider
    state            message_state NOT NULL DEFAULT 'queued',
    scheduled_for    timestamptz,
    sent_at          timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_msglog_schedule ON message_log(scheduled_for) WHERE state = 'queued';

-- In-app "Operational Log" feed.
CREATE TABLE notifications (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    title            text NOT NULL,
    body             text,
    type             text NOT NULL,           -- 'booking' | 'reminder' | 'payment' | 'system'
    read             boolean NOT NULL DEFAULT false,
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_org ON notifications(organization_id, created_at DESC);

-- =============================================================================
-- AUDIT LOG  (who accessed/changed what — required for health data)
-- =============================================================================
CREATE TABLE audit_log (
    id               bigserial PRIMARY KEY,
    organization_id  uuid REFERENCES organizations(id) ON DELETE SET NULL,
    actor_user_id    uuid REFERENCES app_users(id) ON DELETE SET NULL,
    action           text NOT NULL,           -- 'read' | 'create' | 'update' | 'delete'
    entity           text NOT NULL,           -- 'customer' | 'appointment' | ...
    entity_id        uuid,
    at               timestamptz NOT NULL DEFAULT now(),
    ip               inet,
    meta             jsonb
);
CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);
CREATE INDEX idx_audit_actor  ON audit_log(actor_user_id, at DESC);

-- =============================================================================
-- updated_at TRIGGER
-- =============================================================================
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['organizations','locations','staff','services','customers','appointments']
  LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_%s_updated BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION set_updated_at();', t, t);
  END LOOP;
END $$;

-- =============================================================================
-- ROW-LEVEL SECURITY  (tenant isolation, if using Supabase / Postgres RLS)
-- =============================================================================
-- Enable RLS on every tenant-owned table and add a policy that limits rows to
-- the caller's organization. Example for `customers` (repeat per table). The
-- app must set the request's org, e.g. via a JWT claim read by current_setting.
--
-- ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY tenant_isolation ON customers
--   USING (organization_id = (auth.jwt() ->> 'org_id')::uuid);
--
-- With RLS, tenant separation is enforced by the database itself — a bug in
-- application code cannot leak one clinic's patients to another.
-- =============================================================================
