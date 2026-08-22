// Deliberately not a 'use server' module: every export of one must be an async
// server action, which would make this helper unaddressable by a unit test and
// needlessly expose it as an action id.

/**
 * The post-payment return target for the mock gateway page.
 *
 * Only a same-site absolute path is allowed. Anything scheme-bearing,
 * protocol-relative or backslash-smuggled would turn the mock checkout into an
 * open redirect — the same "destination taken from client input" defect as the
 * webhook URL that F16-001 removed, in a cheaper disguise.
 */
export function safeReturnPath(raw: string | null | undefined): string {
  const fallback = '/billing';
  if (!raw) return fallback;

  const value = raw.trim();
  if (!value.startsWith('/')) return fallback; // relative, or scheme-bearing
  if (value.startsWith('//')) return fallback; // protocol-relative → off-site
  if (value.includes('\\')) return fallback; // backslash smuggling
  if (/^\/[^/]*:/.test(value)) return fallback; // "/x:..." scheme-ish
  if (/[\r\n]/.test(value)) return fallback; // header/response splitting
  return value;
}
