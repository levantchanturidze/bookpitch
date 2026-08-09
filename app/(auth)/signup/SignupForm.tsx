'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';

// TypeScript declaration for the Cloudflare Turnstile browser global.
declare global {
  interface Window {
    turnstile?: {
      render: (
        el: HTMLElement,
        opts: {
          sitekey: string;
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

export default function SignupForm() {
  const router = useRouter();
  const [status, setStatus] = useState<'idle' | 'submitting' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!SITE_KEY) return; // No site key: skip widget (dev / CI).

    function renderWidget() {
      if (!window.turnstile || !containerRef.current || widgetIdRef.current) return;
      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: SITE_KEY,
        callback: (token) => setCaptchaToken(token),
        'expired-callback': () => setCaptchaToken(null),
        'error-callback': () => setCaptchaToken(null),
      });
    }

    const scriptId = 'cf-turnstile-script';
    if (window.turnstile) {
      renderWidget();
    } else {
      let script = document.getElementById(scriptId) as HTMLScriptElement | null;
      if (!script) {
        script = document.createElement('script');
        script.id = scriptId;
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
      }
      script.addEventListener('load', renderWidget);
      return () => script!.removeEventListener('load', renderWidget);
    }
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
        setCaptchaToken(null);
      }
      return;
    }
    // Account is pending email verification — redirect to the "check your inbox"
    // page. The org and user are NOT created until the verification link is clicked.
    router.push('/onboard/pending');
  }

  // When a site key is configured, the button is disabled until the CAPTCHA is
  // solved. In dev (no site key) the button is always enabled.
  const submitDisabled = status === 'submitting' || (!!SITE_KEY && !captchaToken);

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

      {SITE_KEY && <div ref={containerRef} className="flex justify-center" />}

      {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>}

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
