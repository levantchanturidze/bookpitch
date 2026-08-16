// -----------------------------------------------------------------------------
// Minimal in-house i18n. We deliberately avoid next-intl / lingui for the
// MVP: the catalog is small, no route-based locale switching yet, and
// keeping the shape tiny lets us swap in a bigger library later without
// touching call sites.
//
// Usage:
//   import { t, formatCurrency } from '@/lib/i18n';
//   t('scheduler.title')                   // → localized string
//   formatCurrency(120)                    // → "120,00 ₾"
//
// The locale is read from the LOCALE env for server code and from
// <html lang> / a future cookie for the browser. Default: ka.
// -----------------------------------------------------------------------------

export type Locale = 'ka' | 'en';

export const DEFAULT_LOCALE: Locale = (process.env.LOCALE as Locale) ?? 'ka';

const CATALOG: Record<Locale, Record<string, string>> = {
  ka: {
    'app.name': 'Bookpitch',
    'nav.scheduler': 'დაგეგმარება',
    'nav.patients': 'პაციენტები',
    'nav.reminders': 'შეხსენებები',
    'nav.settings': 'პარამეტრები',
    'signin.title': 'შედით სისტემაში',
    'signin.email': 'ელფოსტა',
    'signin.password': 'პაროლი',
    'signin.submit': 'შესვლა',
    'signin.forgot': 'დაგავიწყდათ პაროლი?',
    'reset.title': 'პაროლის აღდგენა',
    'reset.emailHint': 'შეიყვანეთ ელფოსტა და თუ მისამართი რეგისტრირებულია, გამოვაგზავნით ბმულს.',
    'reset.newPassword': 'ახალი პაროლი',
    'reset.sendLink': 'ბმულის გაგზავნა',
    'reset.setPassword': 'პაროლის დაყენება',
    'reset.back': 'უკან შესვლის გვერდზე',
    'common.save': 'შენახვა',
    'common.cancel': 'გაუქმება',
    'common.loading': 'იტვირთება…',
    'common.confirm': 'დადასტურება',
    'common.error': 'რაღაც არასწორად წავიდა.',
    'booking.slot_taken': 'ეს დრო უკვე დაკავებულია. გთხოვთ, სხვა დრო აირჩიოთ.',
    'booking.slot_just_taken':
      'ეს სლოტი სწორედ ახლა დაიჯავშნა. სია განახლდა — გთხოვთ, სხვა დრო აირჩიოთ.',
    'booking.no_slots': 'ამ თარიღზე თავისუფალი დრო არ არის.',
    'booking.slots_loading': 'ხელმისაწვდომი დრო იტვირთება…',
  },
  en: {
    'app.name': 'Bookpitch',
    'nav.scheduler': 'Scheduler',
    'nav.patients': 'Patients',
    'nav.reminders': 'Reminders',
    'nav.settings': 'Settings',
    'signin.title': 'Sign in',
    'signin.email': 'Email',
    'signin.password': 'Password',
    'signin.submit': 'Sign in',
    'signin.forgot': 'Forgot password?',
    'reset.title': 'Reset password',
    'reset.emailHint': 'Enter your email and we’ll send a reset link if the address is on file.',
    'reset.newPassword': 'New password',
    'reset.sendLink': 'Send reset link',
    'reset.setPassword': 'Set new password',
    'reset.back': 'Back to sign in',
    'common.save': 'Save',
    'common.cancel': 'Cancel',
    'common.loading': 'Loading…',
    'common.confirm': 'Confirm',
    'common.error': 'Something went wrong.',
    'booking.slot_taken': 'That time slot is already taken. Please choose another.',
    'booking.slot_just_taken':
      'That slot was just taken. The list has been refreshed — please choose another.',
    'booking.no_slots': 'No available times on this date for this provider.',
    'booking.slots_loading': 'Loading available times…',
  },
};

export function t(key: string, locale: Locale = DEFAULT_LOCALE): string {
  return CATALOG[locale]?.[key] ?? CATALOG.en[key] ?? key;
}

// Currency formatting. GEL uses ₾, comma as decimal separator, space as
// thousands separator (ka-GE convention). Intl.NumberFormat handles both.
export function formatCurrency(
  amount: number,
  currency = 'GEL',
  locale: Locale = DEFAULT_LOCALE,
): string {
  const bcp47 = locale === 'ka' ? 'ka-GE' : 'en-US';
  try {
    return new Intl.NumberFormat(bcp47, { style: 'currency', currency }).format(amount);
  } catch {
    // Fallback: node's ICU may lack ka data in some builds; fall back to a
    // hand-rolled "123,45 ₾" for GEL, or "$123.45" for everything else.
    if (currency === 'GEL' && locale === 'ka') {
      return `${amount.toFixed(2).replace('.', ',')} ₾`;
    }
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export function formatDate(d: Date, locale: Locale = DEFAULT_LOCALE): string {
  const bcp47 = locale === 'ka' ? 'ka-GE' : 'en-US';
  return new Intl.DateTimeFormat(bcp47, { dateStyle: 'medium' }).format(d);
}
