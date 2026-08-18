import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isPublicPath } from '@/auth.config';
import {
  LEGAL_DOCUMENT_STATUS,
  LEGAL_DOCUMENT_VERSION,
  OPERATOR_IDENTITY,
  isLegalTextApproved,
} from '@/lib/legal';

// -----------------------------------------------------------------------------
// P15-001 — the public legal surface.
//
// Before this, /privacy and /terms did not exist. The proxy matcher in
// proxy.ts catches every unmatched path and redirects it to /signin, so both
// URLs answered 307 → /signin in production: indistinguishable from a typo.
// Meanwhile the schema stores allergies, clinical notes and treatment history.
//
// These tests hold three separate properties, because each can break on its
// own:
//   1. the documents are REACHABLE without a session;
//   2. they are LINKED from the pages that collect data, not merely deployed;
//   3. while unapproved, they cannot silently masquerade as reviewed text.
// -----------------------------------------------------------------------------

const read = (p: string) => readFileSync(p, 'utf8');

const PRIVACY_PAGE = 'app/(legal)/privacy/page.tsx';
const TERMS_PAGE = 'app/(legal)/terms/page.tsx';

describe('P15-001 legal documents are reachable without a session', () => {
  it('treats /privacy and /terms as public paths', () => {
    expect(isPublicPath('/privacy')).toBe(true);
    expect(isPublicPath('/terms')).toBe(true);
  });

  it('still gates the application surfaces it was already gating', () => {
    // The complement: widening the allow-list must not have opened anything
    // else. If this ever passes for /patients the fix has gone wrong.
    for (const path of ['/patients', '/scheduler', '/settings', '/platform', '/audit']) {
      expect(isPublicPath(path)).toBe(false);
    }
  });

  it('does not make a privacy-adjacent in-app route public by accident', () => {
    // /settings/privacy is the authenticated GDPR tooling, not the notice.
    expect(isPublicPath('/settings/privacy')).toBe(false);
  });

  it('ships an actual page component for each public legal path', () => {
    for (const file of [PRIVACY_PAGE, TERMS_PAGE]) {
      expect(read(file)).toContain('export default function');
    }
  });
});

describe('P15-001 legal documents are linked from data-collecting surfaces', () => {
  it('links both documents from the signup page', () => {
    const signup = read('app/(auth)/signup/page.tsx');
    expect(signup).toContain('LegalFooter');
    // `notice` is what renders the point-of-collection consent wording.
    expect(signup).toMatch(/<LegalFooter\s+notice\s*\/>/);
  });

  it('links both documents from the sign-in page', () => {
    expect(read('app/(auth)/signin/page.tsx')).toContain('LegalFooter');
  });

  it('the footer points at both documents', () => {
    const footer = read('components/legal/LegalFooter.tsx');
    expect(footer).toContain('href="/privacy"');
    expect(footer).toContain('href="/terms"');
  });

  it('states at the point of collection that verification email will be sent', () => {
    const footer = read('components/legal/LegalFooter.tsx');
    expect(footer).toMatch(/verification link/i);
  });
});

describe('P15-001 unreviewed text cannot pass itself off as approved', () => {
  it('is still marked draft', () => {
    // This is a tripwire, not a preference. If someone flips the constant, the
    // legal-review checklist has to have been completed first — see
    // docs/legal-review-checklist.md.
    expect(LEGAL_DOCUMENT_STATUS).toBe('draft');
    expect(isLegalTextApproved()).toBe(false);
  });

  it('renders a draft banner whenever the text is unapproved', () => {
    const chrome = read('components/legal/LegalPage.tsx');
    expect(chrome).toContain('Draft — not legally reviewed');
    // The banner must be conditional on the status constant, not hard-coded
    // in a way that would keep showing after genuine approval.
    expect(chrome).toContain("LEGAL_DOCUMENT_STATUS === 'approved'");
  });

  it('carries a comparable version string for consent records', () => {
    // customers.consent_version stores this; a rendered date would not compare.
    expect(LEGAL_DOCUMENT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\./);
  });

  it('invents no operator identity', () => {
    // Publishing a plausible-looking company name or address would misstate
    // who is legally responsible. Absent is honest; fabricated is not.
    for (const value of Object.values(OPERATOR_IDENTITY)) {
      expect(value).toBeNull();
    }
  });
});

describe('P15-001 published text claims only what the code does', () => {
  const privacy = read(PRIVACY_PAGE);
  const terms = read(TERMS_PAGE);

  it('claims no regulatory compliance or certification', () => {
    // Matches a claim of compliance, not the disclaimer that denies one.
    for (const banned of [
      /\bis GDPR[- ]compliant\b/i,
      /\bHIPAA[- ]compliant\b/i,
      /\bfully compliant\b/i,
      /\bcertified\b/i,
      /\bISO 27001\b/i,
    ]) {
      expect(privacy).not.toMatch(banned);
      expect(terms).not.toMatch(banned);
    }
  });

  it('makes no uptime, SLA or liability promise in the terms', () => {
    for (const banned of [/\b99\.\d+%/, /\bservice level agreement\b/i, /\buptime guarantee\b/i]) {
      expect(terms).not.toMatch(banned);
    }
  });

  it('discloses the erasure limits that actually exist', () => {
    // The audit log is append-only (CLAUDE.md invariant 3) and treatment
    // history survives redaction (P15-005). Both must be stated, because a
    // reader relying on "delete my data" would otherwise be misled.
    expect(privacy).toMatch(/append-only/i);
    expect(privacy).toMatch(/treatment history/i);
  });

  it('names insurance data among what redaction clears', () => {
    // Ties the notice to the P15-002 fix: if erasure regresses, the notice
    // becomes false, and this is the link between the two.
    expect(privacy).toMatch(/insurance policy number/i);
  });

  it('does not promise EU-only backup residency, which is not guaranteed', () => {
    // The page is REQUIRED to discuss backup residency, so "mentions EU-only"
    // cannot be the test. The property that actually matters: every sentence
    // raising EU-only residency must deny it, never assert it.
    const sentences = privacy
      .replace(/\s+/g, ' ')
      .split(/(?<=\.)\s+/)
      .filter((sentence) => /EU[- ]only/i.test(sentence));

    expect(sentences.length).toBeGreaterThan(0); // the gap is disclosed at all
    for (const sentence of sentences) {
      expect(sentence).toMatch(/\bnot\b/i);
    }
    expect(privacy).toMatch(/not currently guaranteed to be EU-only/i);
  });

  it('carries the clinical disclaimer the product needs', () => {
    expect(terms).toMatch(/not a medical device/i);
  });
});
