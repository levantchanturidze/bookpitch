import LegalPage, { LegalSection, OperatorIdentityBlock } from '@/components/legal/LegalPage';

export const metadata = { title: 'Terms of service · Bookpitch' };

// -----------------------------------------------------------------------------
// P15-001 — public terms of service.
//
// Scope discipline: this page states operating rules that are actually
// enforced by the software, plus the acceptable-use restrictions the operator
// needs during a pilot. It deliberately contains NO service-level commitment,
// NO uptime figure, NO support response time and NO liability or warranty
// terms — those are commercial and legal promises that only the operator can
// make, and inventing them here would create obligations nobody agreed to.
//
// The pilot limitations described below are real: see
// docs/pilot-plan-and-go-no-go.md and docs/phase-15-risk-register.md.
// -----------------------------------------------------------------------------

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of service"
      intro="The rules for using Bookpitch, and what it does not promise."
    >
      <LegalSection heading="Who provides the service">
        <OperatorIdentityBlock />
      </LegalSection>

      <LegalSection heading="Accounts">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            An organisation is created by verifying an email address you control. Accounts are for
            named people; credentials are not to be shared between staff.
          </li>
          <li>
            Administrators cannot set another person’s password. Recovery is by emailed reset link
            only.
          </li>
          <li>
            Every organisation must keep at least one active owner. The software refuses to remove
            the last one.
          </li>
          <li>
            Where multi-factor authentication is enrolled, keep your recovery codes somewhere you
            can reach without the account. Each code works once.
          </li>
        </ul>
      </LegalSection>

      <LegalSection heading="Acceptable use">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Only enter client or patient data you are entitled to hold and process, and only for the
            care or service you are providing.
          </li>
          <li>
            Do not attempt to reach another organisation’s data, probe for authorisation weaknesses,
            or use automated bulk access against the service.
          </li>
          <li>Do not use the service to send unsolicited or marketing email.</li>
          <li>
            Do not upload content unrelated to scheduling and client records, and do not use the
            service to store data you have no lawful basis to keep.
          </li>
        </ul>
      </LegalSection>

      <LegalSection heading="Email you will receive">
        <p>
          Creating an account generates a verification email. Operating the service generates
          transactional messages — appointment reminders and, where enabled, security and audit
          notifications. These are necessary to the service rather than marketing, and are sent to
          the addresses your organisation records.
        </p>
      </LegalSection>

      <LegalSection heading="Clinical disclaimer">
        <p>
          Bookpitch is scheduling and record-keeping software. It is not a medical device, it does
          not provide clinical decision support, and it must not be relied on for diagnosis or
          treatment. Clinical responsibility for anything recorded in it remains entirely with the
          practitioner and the organisation.
        </p>
      </LegalSection>

      <LegalSection heading="Pilot status and known limitations">
        <p>
          The service is in a controlled pilot. Stated plainly, because you should be able to decide
          whether that is acceptable for your practice:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Backups are taken on a daily cycle. There is no point-in-time recovery, so a failure
            could lose up to roughly a day of changes.
          </li>
          <li>The service is operated by a single person, without 24-hour cover.</li>
          <li>Email sender authentication for this domain is not yet fully configured.</li>
        </ul>
        <p>Keep your own records of anything you cannot afford to lose during the pilot.</p>
      </LegalSection>

      <LegalSection heading="What these terms do not include">
        <p>
          No availability target, support response time, warranty, or limitation of liability is
          stated here, and none should be inferred. Those terms have not been drafted or reviewed,
          and this page is not a contract. See the privacy notice for how data is handled.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
