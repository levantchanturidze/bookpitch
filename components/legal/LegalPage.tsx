import Link from 'next/link';
import { LEGAL_DOCUMENT_STATUS, LEGAL_DOCUMENT_VERSION, OPERATOR_IDENTITY } from '@/lib/legal';

// -----------------------------------------------------------------------------
// Shared chrome for the public legal documents (P15-001).
//
// Two things here are load-bearing rather than decorative:
//
//  1. The draft banner. While LEGAL_DOCUMENT_STATUS is 'draft' the reader is
//     told, before any of the text, that it has not been through legal review.
//     A privacy notice that looks finished but is not reviewed is worse than a
//     visibly unfinished one, because a reader reasonably relies on it.
//
//  2. The operator-identity block. A data-protection notice has to name the
//     controller. We do not have that name, and inventing one would be a false
//     statement about a real legal entity, so the gap is rendered explicitly
//     instead of being quietly omitted.
//
// Colour choices are constrained by the Phase 14 contrast gate
// (scripts/analyze-ui.mjs + tests/ui-surface-analysis.test.ts): every
// foreground/background pair below is AA or better on its own surface.
// -----------------------------------------------------------------------------

export function LegalDraftBanner() {
  if (LEGAL_DOCUMENT_STATUS === 'approved') return null;
  return (
    <div
      role="note"
      aria-labelledby="legal-draft-heading"
      className="mb-8 rounded-xl border-2 border-amber-500 bg-amber-50 p-4"
    >
      <h2 id="legal-draft-heading" className="text-sm font-extrabold text-amber-900">
        Draft — not legally reviewed
      </h2>
      <p className="mt-2 text-sm text-amber-900">
        This document describes how the software actually behaves, but it has <strong>not</strong>{' '}
        been reviewed or approved by a qualified legal adviser. It is not a contract, and it is not
        a statement of regulatory compliance. Do not rely on it. Sections marked{' '}
        <em>“not yet supplied”</em> are genuinely incomplete.
      </p>
      <p className="mt-2 font-mono text-xs text-amber-900">version {LEGAL_DOCUMENT_VERSION}</p>
    </div>
  );
}

export function OperatorIdentityBlock() {
  const { legalName, registrationNumber, postalAddress, privacyContact } = OPERATOR_IDENTITY;
  const complete = Boolean(legalName && registrationNumber && postalAddress && privacyContact);

  if (complete) {
    return (
      <ul className="mt-3 space-y-1 text-sm text-slate-700">
        <li>{legalName}</li>
        <li>Registration number: {registrationNumber}</li>
        <li>{postalAddress}</li>
        <li>Privacy contact: {privacyContact}</li>
      </ul>
    );
  }

  return (
    <p className="mt-3 rounded-lg border border-slate-300 bg-slate-100 p-3 text-sm text-slate-800">
      <strong>Not yet supplied.</strong> The operating entity’s registered name, company
      registration number, postal address and privacy contact have deliberately not been filled in,
      because inventing them would misstate who is legally responsible for your data. Until this
      section names a real entity, this notice is incomplete.
    </p>
  );
}

export default function LegalPage({
  title,
  intro,
  children,
}: {
  title: string;
  intro: string;
  children: React.ReactNode;
}) {
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-12">
      <article className="mx-auto w-full max-w-3xl rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <nav className="mb-8 flex flex-wrap gap-x-4 gap-y-2 text-sm">
          <Link
            href="/signin"
            className="rounded font-semibold text-teal-800 underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
          >
            Sign in
          </Link>
          <Link
            href="/privacy"
            className="rounded font-semibold text-teal-800 underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
          >
            Privacy
          </Link>
          <Link
            href="/terms"
            className="rounded font-semibold text-teal-800 underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
          >
            Terms
          </Link>
        </nav>

        <h1 className="text-2xl font-extrabold tracking-tight text-slate-900">{title}</h1>
        <p className="mt-2 text-sm text-slate-700">{intro}</p>

        <div className="mt-8">
          <LegalDraftBanner />
        </div>

        <div className="space-y-8">{children}</div>
      </article>
    </main>
  );
}

export function LegalSection({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="text-base font-bold text-slate-900">{heading}</h2>
      <div className="mt-2 space-y-2 text-sm text-slate-700">{children}</div>
    </section>
  );
}
