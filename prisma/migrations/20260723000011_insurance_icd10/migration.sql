-- Insurance + ICD-10 support. Georgia's private + state insurers accept
-- claims tied to (patient, service_date, ICD-10 diagnosis, procedure,
-- amount). We store just enough to produce a monthly CSV export.
--
-- On appointments — a diagnosis code + free-form description at the time
-- of the visit. Nullable because not every visit is insurance-billable
-- (e.g. salon services).
--
-- On customers — the insurer + policy number the patient carries. Both
-- nullable; a customer without insurance leaves them empty.

ALTER TABLE "appointments"
    ADD COLUMN "icd10_code"        TEXT,
    ADD COLUMN "icd10_description" TEXT;

ALTER TABLE "customers"
    ADD COLUMN "insurer_name"            TEXT,
    ADD COLUMN "insurance_policy_number" TEXT;

-- Partial index — supports the claims export path which filters
-- (organization_id, insurer_name, starts_at, icd10_code IS NOT NULL).
CREATE INDEX "idx_customers_org_insurer"
    ON "customers" ("organization_id", "insurer_name")
    WHERE "insurer_name" IS NOT NULL;

CREATE INDEX "idx_appointments_org_starts_icd"
    ON "appointments" ("organization_id", "starts_at")
    WHERE "icd10_code" IS NOT NULL;
