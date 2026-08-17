'use client';

import { useId, type ReactNode } from 'react';

// -----------------------------------------------------------------------------
// P14-004 — form fields whose errors are actually attached to the input.
//
// The product has 96 <input> elements and, before this, zero uses of
// aria-invalid and zero uses of aria-describedby. Validation errors were
// rendered as a sibling <p>, which means a screen-reader user tabbing to a
// rejected field hears its label and nothing else — no indication the field is
// in error, and no way to reach the reason without leaving the field. That is
// WCAG 2.2 3.3.1 (Error Identification) and 3.3.2 (Labels or Instructions),
// both Level A.
//
// `Field` owns the wiring so call sites cannot forget it:
//   * generates matching ids for control, hint and error
//   * marks the control aria-invalid when an error is present
//   * points aria-describedby at the hint, the error, or both, in reading order
//   * gives the error role="alert" so it is announced when it appears
//
// The render-prop shape is deliberate: it works with plain <input>, <select>,
// <textarea> and any custom control, without this component needing to know
// which, and without forcing every existing form onto a new input component.
// -----------------------------------------------------------------------------

export type FieldRenderProps = {
  id: string;
  'aria-invalid': boolean | undefined;
  'aria-describedby': string | undefined;
};

export type FieldProps = {
  label: ReactNode;
  /** Field-level validation message. Presence is what marks the field invalid. */
  error?: string | null;
  /**
   * Mark the control invalid WITHOUT rendering a per-field message.
   *
   * Needed by enumeration-safe forms: sign-in returns one message for "unknown
   * email" and "wrong password" alike, so attaching it to a single field would
   * tell an attacker which half was wrong. The form-level StatusMessage carries
   * the text; both fields still need aria-invalid so a screen-reader user knows
   * the submission was rejected.
   */
  invalid?: boolean;
  /** Persistent helper text, e.g. formatting rules. */
  hint?: ReactNode;
  required?: boolean;
  className?: string;
  labelClassName?: string;
  children: (props: FieldRenderProps) => ReactNode;
};

export default function Field({
  label,
  error,
  invalid,
  hint,
  required,
  className = 'block',
  labelClassName = 'mb-1 block text-xs font-semibold text-slate-600',
  children,
}: FieldProps) {
  const reactId = useId();
  const id = `field-${reactId}`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  // Reading order: the hint explains what is wanted, the error explains what
  // went wrong. Screen readers announce describedby ids in the order given.
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');

  return (
    <div className={className}>
      <label htmlFor={id} className={labelClassName}>
        {label}
        {required && (
          <>
            {' '}
            <span aria-hidden="true" className="text-rose-500">
              *
            </span>
            <span className="sr-only">(required)</span>
          </>
        )}
      </label>
      {children({
        id,
        'aria-invalid': error || invalid ? true : undefined,
        'aria-describedby': describedBy || undefined,
      })}
      {hint && (
        <p id={hintId} className="mt-1 text-[11px] leading-relaxed text-slate-500">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="mt-1 text-[11px] font-medium text-rose-600">
          {error}
        </p>
      )}
    </div>
  );
}
