// -----------------------------------------------------------------------------
// Public legal-surface metadata.
//
// P15-001: Bookpitch stores special-category health data (customers.allergies,
// customers.clinical_notes, treatment_history) and had no public privacy
// notice, no terms, and no consent surface at signup. These constants exist so
// the published state of those documents is a value the test suite can assert
// on, rather than a claim someone makes in a review comment.
//
// APPROVAL STATUS IS NOT COSMETIC. While `status` is 'draft', every legal page
// renders an unmissable banner saying the text is unreviewed, and
// `docs/legal-review-checklist.md` is the gate that flips it. Do not change
// `status` to 'approved' as part of an unrelated change: it is a
// representation about a document a qualified reviewer has signed off on, and
// only the operator can make that representation.
// -----------------------------------------------------------------------------

export type LegalDocumentStatus = 'draft' | 'approved';

/**
 * Whether the published legal text has been through qualified human review.
 *
 * Flipping this to 'approved' is an assertion that a named reviewer approved
 * the exact rendered text. See docs/legal-review-checklist.md.
 */
export const LEGAL_DOCUMENT_STATUS: LegalDocumentStatus = 'draft';

/**
 * Bumped whenever the substantive text changes. Recorded against a customer's
 * consent in `customers.consent_version`, so it must be a stable, comparable
 * string rather than a rendered date.
 */
export const LEGAL_DOCUMENT_VERSION = '2026-08-18.draft-1';

/**
 * Operator identity. Deliberately null: publishing an invented company name,
 * registration number or postal address would be a false statement about a
 * real legal entity, and a data-protection notice is required to name the
 * actual controller. The pages render a clearly-marked gap instead, which is
 * honest, rather than a plausible-looking placeholder a reader could mistake
 * for the real thing.
 */
export const OPERATOR_IDENTITY: {
  legalName: string | null;
  registrationNumber: string | null;
  postalAddress: string | null;
  privacyContact: string | null;
  securityContact: string | null;
} = {
  legalName: null,
  registrationNumber: null,
  postalAddress: null,
  privacyContact: null,
  securityContact: null,
};

export function isLegalTextApproved(): boolean {
  return LEGAL_DOCUMENT_STATUS === 'approved';
}
