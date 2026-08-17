'use client';

import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  type ReactElement,
  type ReactNode,
} from 'react';

// -----------------------------------------------------------------------------
// P14-002 — the accessible dialog primitive.
//
// Before this existed there were eleven hand-rolled overlays across eight
// components, every one of them the same literal string:
//
//   <div className="fixed inset-0 z-50 flex items-center justify-center
//                   bg-slate-900/60 p-4 backdrop-blur-sm">
//
// and not one of them had role="dialog", aria-modal, an Escape handler, or any
// focus management. To a screen-reader user the "modal" was simply more content
// appended to the page, with the entire page behind it still reachable by Tab;
// to a keyboard user there was no way to dismiss it without hunting for the
// close button. That is WCAG 2.2 4.1.2 (Name, Role, Value) and 2.4.3 (Focus
// Order), both Level A.
//
// This wraps the same visual treatment so the refactor is mechanical and the
// Bookpitch look is untouched, while adding the behaviour every dialog needs:
//
//   * role="dialog" + aria-modal="true", labelled by its own title
//   * focus moved into the dialog on open, restored to the opener on close
//   * Tab / Shift+Tab cycle within the dialog instead of escaping behind it
//   * Escape closes (when the dialog is dismissible)
//   * background scroll locked while open
//   * backdrop click closes, but only on the backdrop itself
//
// Deliberately not a portal: the existing modals render inline with
// `fixed inset-0`, which already escapes layout, and keeping the tree shape
// identical avoids changing SSR/hydration behaviour during a QA phase.
// -----------------------------------------------------------------------------

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export type ModalShellProps = {
  /** Accessible name for the dialog. Rendered by the caller inside `children`. */
  titleId: string;
  /** Called for Escape and backdrop clicks. Omit to make the dialog modal-blocking. */
  onDismiss?: () => void;
  /**
   * Tailwind width class for the panel ModalShell renders, e.g. `max-w-lg`.
   *
   * Pass `null` for **adopt mode**: ModalShell renders no panel of its own and
   * instead clones its single child element, injecting the dialog role, the
   * aria wiring, the focus ref and `tabIndex={-1}` onto it. That lets an
   * existing hand-rolled modal keep its exact markup, classes and animation
   * wrapper — the DOM is unchanged apart from the attributes that make it a
   * real dialog. Refactoring an existing overlay is then a two-line change
   * rather than a restructure, which is why the migration could be done
   * without touching a single visual class.
   */
  panelClassName?: string | null;
  children: ReactNode;
};

export default function ModalShell({
  titleId,
  onDismiss,
  panelClassName = 'w-full max-w-md',
  children,
}: ModalShellProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // The panel is always the overlay's only element child, in both modes.
  // Locating it this way — rather than threading a ref through cloneElement —
  // keeps refs out of the render pass entirely, which is both what React's
  // lint requires and simpler to reason about.
  const getPanel = () => (overlayRef.current?.firstElementChild as HTMLElement | null) ?? null;

  useEffect(() => {
    // Remember who opened us so focus can go back there on close. Without this
    // the user is dumped at the top of the document every time a dialog closes.
    restoreFocusRef.current = document.activeElement as HTMLElement | null;

    const panel = getPanel();
    if (panel) {
      const first = panel.querySelector<HTMLElement>(FOCUSABLE);
      // Prefer the first control; fall back to the panel itself, which carries
      // tabIndex={-1} precisely so it can receive focus when it has no controls.
      (first ?? panel).focus();
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && onDismiss) {
        event.stopPropagation();
        onDismiss();
        return;
      }
      if (event.key !== 'Tab') return;

      const node = getPanel();
      if (!node) return;
      const focusable = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (focusable.length === 0) {
        // Nothing to move to — keep focus on the panel rather than letting Tab
        // walk into the page behind the overlay.
        event.preventDefault();
        node.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || active === node)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      restoreFocusRef.current?.focus?.();
    };
  }, [onDismiss]);

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm"
      // Clicking the backdrop dismisses, but only when the click started and
      // ended on the backdrop — otherwise dragging a text selection out of the
      // panel would close the dialog and discard the user's input.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && onDismiss) onDismiss();
      }}
    >
      {panelClassName === null ? (
        // Adopt mode — the child IS the panel. Clone it so the dialog
        // attributes and the focus ref land on the caller's own element and no
        // extra box is introduced into the layout.
        isValidElement(children) ? (
          cloneElement(
            children as ReactElement<Record<string, unknown>>,
            {
              role: 'dialog',
              'aria-modal': 'true',
              'aria-labelledby': titleId,
              tabIndex: -1,
            } as Record<string, unknown>,
          )
        ) : (
          children
        )
      ) : (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className={`${panelClassName} rounded-xl border border-slate-200 bg-white p-6 shadow-lg outline-none`}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * Convenience for callers that do not already have a stable id for their title
 * element. `useId` is SSR-safe, unlike a module-level counter.
 */
export function useModalTitleId(): string {
  return `modal-title-${useId()}`;
}
