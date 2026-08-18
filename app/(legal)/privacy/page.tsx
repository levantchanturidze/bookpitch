import LegalPage, { LegalSection, OperatorIdentityBlock } from '@/components/legal/LegalPage';

export const metadata = { title: 'Privacy notice · Bookpitch' };

// -----------------------------------------------------------------------------
// P15-001 — public privacy notice.
//
// Every factual claim below was read out of the code, not assumed. If you
// change one of these behaviours, change this page in the same PR:
//
//   data categories      prisma/schema.prisma → model Customer, TreatmentHistory
//   encrypted at rest    lib/customers.ts (allergies, clinicalNotes via
//                        lib/crypto.ts encryptField); email_outbox.to_address
//   retention window     organizations.customer_retention_years (default 7)
//   retention sweep      lib/gdpr.ts runRetentionTick()
//   erasure behaviour    lib/gdpr.ts anonymizeCustomer() + CUSTOMER_REDACTION_FIELDS
//   export               lib/gdpr.ts exportCustomerData()
//   audit immutability   CLAUDE.md invariant 3 — append-only, DB-enforced
//   hosting region       vercel.json regions ["fra1"], ARCHITECTURE.md §2
//
// Deliberately absent: any claim of GDPR, HIPAA or other regulatory
// compliance, and any promise about backup data residency. The first requires
// qualified review; the second is a known open risk (backup ciphertext
// residency is not currently guaranteed EU-only) and stating otherwise here
// would be false.
// -----------------------------------------------------------------------------

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy notice"
      intro="What Bookpitch stores, why, where it lives, and what can be removed."
    >
      <LegalSection heading="Who is responsible for your data">
        <p>
          Bookpitch is scheduling and records software used by clinics and salons. Each organisation
          using it controls its own patient and client records; the operator of this installation
          runs the platform those records sit on.
        </p>
        <OperatorIdentityBlock />
      </LegalSection>

      <LegalSection heading="What is stored">
        <p>The database holds the following categories of personal data:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Account data</strong> for staff users — email address, authentication
            credentials, organisation membership and role, and multi-factor enrolment state.
          </li>
          <li>
            <strong>Client and patient identity</strong> — name, email address, telephone number,
            date of birth, gender, and an optional avatar image reference.
          </li>
          <li>
            <strong>Health data</strong> — recorded allergies, clinical notes, and treatment history
            entries. This is special-category data and is treated as the most sensitive content in
            the system.
          </li>
          <li>
            <strong>Insurance data</strong> — insurer name and policy number, where an organisation
            records them for claim exports.
          </li>
          <li>
            <strong>Appointments and payments</strong> — times, services, assigned staff, status,
            prices, payment method and status, and where recorded, a diagnostic code for a completed
            visit.
          </li>
          <li>
            <strong>Operational records</strong> — an append-only audit log of actions taken inside
            an organisation, message delivery records, and security events such as sign-in attempts
            and rate-limit decisions.
          </li>
        </ul>
      </LegalSection>

      <LegalSection heading="How it is protected">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Allergies and clinical notes are encrypted at rest at the field level, so they are not
            readable from the raw database rows. Outbound email addresses queued for delivery are
            encrypted the same way.
          </li>
          <li>
            Every query against tenant data is filtered by organisation, and the database enforces
            row-level isolation independently of the application code.
          </li>
          <li>
            Access is governed by named roles and permissions. Reaching client contact details or
            clinical records as a platform operator additionally requires a recorded reason,
            re-authentication, and expires automatically; those reads are themselves audited.
          </li>
          <li>Message bodies, recipients and tokens are kept out of application logs.</li>
        </ul>
      </LegalSection>

      <LegalSection heading="Where it is processed">
        <p>
          The application runs in Frankfurt, Germany, and the primary database is hosted in the
          European Union. Encrypted backups are taken on a schedule; the storage region for backup
          copies is not currently guaranteed to be EU-only, and that gap is deliberately stated here
          rather than glossed over.
        </p>
        <p>
          Third parties that necessarily process data to make the service work: the application
          host, the managed database provider, the transactional email provider, the bot-protection
          provider used on the signup form, and an error-monitoring service. Their identities belong
          in this notice and are pending completion alongside the operator details above.
        </p>
      </LegalSection>

      <LegalSection heading="How long it is kept">
        <p>
          Each organisation sets a retention window for its client records, defaulting to seven
          years. A scheduled job finds clients whose records have been untouched for longer than
          that window and who have had no appointment inside it, and redacts them.
        </p>
      </LegalSection>

      <LegalSection heading="Erasure, and its limits">
        <p>
          A client record can be redacted on request. Redaction clears name, email address,
          telephone number, date of birth, gender, avatar, allergies, clinical notes, insurer name
          and insurance policy number. The row itself is retained in a redacted form so that linked
          appointments and payments remain coherent.
        </p>
        <p>
          Two things are <strong>not</strong> removed, and you should know this before relying on a
          deletion request:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            The audit log is append-only and cannot be edited or deleted by anyone, including
            platform administrators. It records that an action happened, by which account, and when.
          </li>
          <li>
            Treatment history entries are retained. Whether they should survive an erasure request,
            or be covered by a clinical-records retention duty instead, is an open question flagged
            for legal review rather than decided in software.
          </li>
        </ul>
        <p>
          A machine-readable export of an individual client’s stored data can be produced by their
          organisation.
        </p>
      </LegalSection>

      <LegalSection heading="Exercising your rights">
        <p>
          If you are a client or patient of a clinic or salon that uses Bookpitch, that organisation
          holds your records — contact them first. Requests about the platform itself should go to
          the privacy contact named above, which is not yet supplied.
        </p>
      </LegalSection>

      <LegalSection heading="What this notice does not claim">
        <p>
          This page describes implemented behaviour. It does not assert compliance with the GDPR,
          HIPAA, Georgian data-protection law, or any other regime, and no part of it has been
          approved by a qualified adviser. Automated checks cannot establish legal compliance, and
          nothing here should be read as if they had.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
