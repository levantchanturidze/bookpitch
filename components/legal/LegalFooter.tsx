import Link from 'next/link';

// -----------------------------------------------------------------------------
// P15-001 — the reachability half of the fix.
//
// Publishing /privacy and /terms is not the same as making them reachable. The
// public auth surfaces are the only pages a prospective user sees before
// handing over an email address, so the links have to live there. `notice`
// carries the point-of-collection wording on the signup form, where consent is
// actually given.
// -----------------------------------------------------------------------------

const linkClass =
  'rounded font-semibold text-slate-700 underline hover:text-slate-900 ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700';

export default function LegalFooter({ notice = false }: { notice?: boolean }) {
  return (
    <div className="mt-6 border-t border-slate-100 pt-4">
      {notice && (
        <p className="mb-3 text-xs text-slate-700">
          By creating a workspace you agree to the{' '}
          <Link href="/terms" className={linkClass}>
            terms of service
          </Link>{' '}
          and confirm you have read the{' '}
          <Link href="/privacy" className={linkClass}>
            privacy notice
          </Link>
          {'. '}
          We will email you a verification link, and the service sends transactional messages such
          as appointment reminders.
        </p>
      )}
      <p className="flex justify-center gap-4 text-xs text-slate-700">
        <Link href="/privacy" className={linkClass}>
          Privacy
        </Link>
        <Link href="/terms" className={linkClass}>
          Terms
        </Link>
      </p>
    </div>
  );
}
