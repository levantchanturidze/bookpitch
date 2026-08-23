'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import StatusMessage from '@/components/ui/StatusMessage';

// TypeScript declaration for the Cloudflare Turnstile browser global.
declare global {
  interface Window {
    turnstile?: {
      render: (
        el: HTMLElement,
        opts: {
          sitekey: string;
          action?: string;
          callback: (token: string) => void;
          'expired-callback': () => void;
          'error-callback': () => void;
        },
      ) => string;
      reset: (widgetId: string) => void;
    };
  }
}

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? '';

// P17-009. The end-to-end signup journey runs against `next start`, where
// NODE_ENV is production and no Turnstile site key is configured — so no widget
// renders, captchaToken stays null and the submit button is permanently
// disabled. That is correct behaviour and the reason the journey has never run.
//
// This supplies the test credential the server also has to be holding. It is
// NOT a client-side bypass: the server accepts this token only when its own
// E2E_TURNSTILE_BYPASS_TOKEN matches AND APP_URL is on loopback (see
// lib/auth/e2e-turnstile-bypass.ts). Setting this variable in a production
// build would put a useless string in the bundle and change nothing — the
// server would still refuse it.
const E2E_BYPASS_TOKEN = process.env.NEXT_PUBLIC_E2E_TURNSTILE_BYPASS_TOKEN ?? '';

export default function SignupForm() {
  const router = useRouter();
  const [status, setStatus] = useState<'idle' | 'submitting' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(E2E_BYPASS_TOKEN || null);
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!SITE_KEY) return; // No site key: skip widget (dev / CI).

    // Phase 13 (2026-08-16): this used to render from the script's `load`
    // event. In production that silently never fired the render — the script
    // loaded, `window.turnstile` was defined a moment later, and the guard
    // inside renderWidget() returned early and was never retried. The result
    // was a signup page with no widget, a permanently disabled submit button,
    // and a completely unusable signup flow that no test could see because no
    // test rendered the real widget. Verified on bookpitch.ge: script present,
    // window.turnstile.render a function, zero widget iframes.
    //
    // The script `load` event is not a guarantee that `window.turnstile` is
    // usable — Cloudflare only guarantees that through its documented
    // `?onload=` callback. So: poll for readiness with a bounded interval,
    // which also covers the case where the script was already loaded by an
    // earlier mount and no `load` event will ever fire again.
    let cancelled = false;
    let poll: ReturnType<typeof setInterval> | null = null;

    function renderWidget(): boolean {
      if (cancelled) return true; // stop polling; the component went away
      if (widgetIdRef.current) return true;
      if (!window.turnstile || typeof window.turnstile.render !== 'function') return false;
      if (!containerRef.current) return false;
      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: SITE_KEY,
        action: 'signup',
        callback: (token) => setCaptchaToken(token),
        'expired-callback': () => setCaptchaToken(null),
        'error-callback': () => setCaptchaToken(null),
      });
      return true;
    }

    const scriptId = 'cf-turnstile-script';
    if (!document.getElementById(scriptId)) {
      const script = document.createElement('script');
      script.id = scriptId;
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }

    if (!renderWidget()) {
      // ~15s of 100ms attempts. Long enough for a slow network, short enough
      // that it cannot leak a timer for the life of the page.
      let attempts = 0;
      poll = setInterval(() => {
        attempts += 1;
        if (renderWidget() || attempts >= 150) {
          if (poll) clearInterval(poll);
          poll = null;
        }
      }, 100);
    }

    return () => {
      cancelled = true;
      if (poll) clearInterval(poll);
    };
  }, []);

  async function submit(fd: FormData) {
    setStatus('submitting');
    setError(null);
    const payload = {
      email: String(fd.get('email') ?? ''),
      password: String(fd.get('password') ?? ''),
      fullName: String(fd.get('fullName') ?? ''),
      orgName: String(fd.get('orgName') ?? ''),
      locationName: String(fd.get('locationName') ?? ''),
      locationType: String(fd.get('locationType') ?? 'clinic'),
      ...(captchaToken ? { turnstileToken: captchaToken } : {}),
    };
    const res = await fetch('/api/onboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as { error?: string } | null;
      setStatus('error');
      setError(err?.error ?? 'Could not create workspace.');
      // Reset the widget so the user can solve a fresh challenge before retrying.
      if (SITE_KEY && widgetIdRef.current && window.turnstile) {
        window.turnstile.reset(widgetIdRef.current);
        setCaptchaToken(E2E_BYPASS_TOKEN || null);
      }
      return;
    }
    // Account is pending email verification — redirect to the "check your inbox"
    // page. The org and user are NOT created until the verification link is clicked.
    router.push('/onboard/pending');
  }

  // Button is disabled while submitting, while waiting for CAPTCHA solution,
  // or in production when site key is entirely absent (misconfiguration).
  const captchaRequired = !!SITE_KEY || process.env.NODE_ENV === 'production';
  const submitDisabled = status === 'submitting' || (captchaRequired && !captchaToken);

  return (
    <form action={submit} className="space-y-4">
      <label className="block">
        <span className="mb-1 block text-xs font-semibold text-slate-600">Your full name</span>
        <input name="fullName" required className={inputCls} autoComplete="name" />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-semibold text-slate-600">Email</span>
        <input name="email" type="email" required className={inputCls} autoComplete="email" />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-semibold text-slate-600">Password</span>
        <input
          name="password"
          type="password"
          required
          minLength={8}
          className={inputCls}
          autoComplete="new-password"
        />
      </label>
      <div className="border-t border-slate-100 pt-4">
        <p className="mb-3 text-xs font-semibold text-slate-500">Workspace</p>
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-slate-600">Organisation name</span>
          <input name="orgName" required className={inputCls} />
        </label>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-slate-600">Location name</span>
            <input name="locationName" defaultValue="Main location" className={inputCls} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-slate-600">Type</span>
            <select name="locationType" defaultValue="clinic" className={inputCls}>
              <option value="clinic">Clinic</option>
              <option value="salon">Salon</option>
            </select>
          </label>
        </div>
      </div>

      {SITE_KEY ? (
        <div ref={containerRef} className="flex justify-center" />
      ) : process.env.NODE_ENV === 'production' ? (
        <StatusMessage tone="error">
          Bot protection is unavailable. Please try again later.
        </StatusMessage>
      ) : null}

      {error && <StatusMessage tone="error">{error}</StatusMessage>}

      <button
        type="submit"
        disabled={submitDisabled}
        className="w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {status === 'submitting' ? 'Creating…' : 'Create workspace'}
      </button>
    </form>
  );
}

const inputCls =
  'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-slate-400 focus:outline-none';
