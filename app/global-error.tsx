'use client';

/**
 * P14-009: last-resort boundary for an error thrown in the root layout itself.
 * Next.js replaces the entire document when this renders, so it must supply its
 * own <html> and <body> — and, unlike every other surface, it cannot rely on
 * globals.css having loaded. Styling is therefore inline and minimal on
 * purpose; this is the screen that has to work when nothing else did.
 *
 * As in app/(app)/error.tsx, the raw error message is never shown (P14-008).
 * Only the digest is surfaced, because that is the value that correlates with
 * a server-side log entry.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang={process.env.LOCALE ?? 'en'}>
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#f8fafc',
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
          color: '#0f172a',
          padding: '1rem',
        }}
      >
        <main
          role="alert"
          style={{
            maxWidth: '28rem',
            width: '100%',
            textAlign: 'center',
            border: '1px solid #e2e8f0',
            borderRadius: '1rem',
            background: '#ffffff',
            padding: '2.5rem',
          }}
        >
          <h1 style={{ fontSize: '1.125rem', fontWeight: 800, margin: 0 }}>Bookpitch is offline</h1>
          <p
            style={{ fontSize: '0.75rem', lineHeight: 1.6, color: '#64748b', marginTop: '0.5rem' }}
          >
            Something went wrong loading the application. Your data has not been changed. Please try
            again in a moment.
          </p>
          {error.digest && (
            <p style={{ fontSize: '0.625rem', color: '#94a3b8', marginTop: '0.75rem' }}>
              Reference: {error.digest}
            </p>
          )}
          <button
            onClick={reset}
            style={{
              marginTop: '1.5rem',
              borderRadius: '0.5rem',
              border: 'none',
              background: '#0f172a',
              color: '#ffffff',
              fontSize: '0.75rem',
              fontWeight: 700,
              padding: '0.625rem 1rem',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
