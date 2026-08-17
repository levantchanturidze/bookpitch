'use client';

import type { ReactNode } from 'react';

// -----------------------------------------------------------------------------
// P14-003 — announced status messages.
//
// A scan of all 87 files under app/ and components/ found zero occurrences of
// aria-live, role="status" and role="alert". Every "Saved", "Could not update
// member", "Slot already taken" in the product was rendered as a plain <p>: a
// sighted user sees it appear, a screen-reader user is told nothing at all,
// because nothing moved focus and nothing was announced. That is WCAG 2.2
// 4.1.3 (Status Messages, Level AA).
//
// Two variants, and the difference matters:
//   * tone="error"   -> role="alert",  aria-live="assertive" — interrupts,
//                       because the user's action did not do what they asked.
//   * everything else-> role="status", aria-live="polite" — waits for a pause,
//                       so a success toast does not talk over the user.
//
// The element is always rendered, even when empty. A live region that is
// inserted into the DOM at the same moment as its text is frequently missed by
// screen readers; keeping the container mounted and swapping only its contents
// is the reliable pattern.
// -----------------------------------------------------------------------------

export type StatusTone = 'success' | 'error' | 'info' | 'warning';

const TONE_CLASSES: Record<StatusTone, string> = {
  success: 'border-emerald-100 bg-emerald-50 text-emerald-800',
  error: 'border-rose-100 bg-rose-50 text-rose-700',
  info: 'border-slate-100 bg-slate-50 text-slate-600',
  warning: 'border-amber-100 bg-amber-50 text-amber-900',
};

export type StatusMessageProps = {
  children?: ReactNode;
  tone?: StatusTone;
  className?: string;
};

export default function StatusMessage({
  children,
  tone = 'info',
  className = '',
}: StatusMessageProps) {
  const isError = tone === 'error';
  const hasContent = children !== null && children !== undefined && children !== false;

  return (
    <div
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      aria-atomic="true"
      className={
        hasContent
          ? `rounded-lg border px-3 py-2 text-xs leading-relaxed ${TONE_CLASSES[tone]} ${className}`
          : // Kept in the DOM so the region is established before text arrives.
            'sr-only'
      }
    >
      {hasContent ? children : null}
    </div>
  );
}

/**
 * Text-only announcer for cases with no visual affordance of their own — for
 * example "Loading availability…" while a spinner is already on screen, or
 * "12 results" after a filter change. Visually hidden, always announced.
 */
export function VisuallyHiddenStatus({ children }: { children?: ReactNode }) {
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {children}
    </div>
  );
}
