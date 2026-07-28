import type { PermissionKey } from '@/lib/rbac';

export type NavItem = {
  id: string;
  href: string;
  label: string | { clinic: string; salon: string };
  icon: 'calendar' | 'users' | 'message' | 'dollar' | 'trending' | 'shield' | 'settings' | 'clock';
  /**
   * Permission required to see this nav entry (spec §5). The server-side
   * layout evaluates `can(ctx, requiredPermission)` per item and passes
   * the result down as `visibleNavIds` to the client Shell.
   *
   * A missing perm hides the entry entirely — Shell never renders a
   * disabled/greyed link. Route-level guards enforce independently, so
   * link visibility is a UX signal, not the authorization.
   */
  requiredPermission: PermissionKey;
};

// Cast helper — `perm()` is the branded-string constructor from lib/rbac.
// Inlined here so nav-items has no cross-package runtime dep.
const p = (s: string): PermissionKey => s as PermissionKey;

// Single source of truth for the sidebar. Paired with each page's
// `requirePermission()` call at the route boundary — the mapping is
// documented in docs/rbac-enforcement-audit.md §15.
export const NAV_ITEMS: NavItem[] = [
  {
    id: 'scheduler',
    href: '/scheduler',
    label: 'Scheduler',
    icon: 'calendar',
    requiredPermission: p('booking.read'),
  },
  {
    id: 'patients',
    href: '/patients',
    // Label follows active location type — the prototype's clinic/salon relabel.
    label: { clinic: 'Patients', salon: 'Clients' },
    icon: 'users',
    requiredPermission: p('client.read:contact'),
  },
  {
    id: 'reminders',
    href: '/reminders',
    label: 'Reminders',
    icon: 'message',
    requiredPermission: p('booking.update'),
  },
  {
    id: 'waitlist',
    href: '/waitlist',
    label: 'Waitlist',
    icon: 'clock',
    requiredPermission: p('booking.read'),
  },
  {
    id: 'billing',
    href: '/billing',
    label: 'Billing & POS',
    icon: 'dollar',
    requiredPermission: p('payment.charge'),
  },
  {
    id: 'analytics',
    href: '/analytics',
    label: 'Business intelligence',
    icon: 'trending',
    requiredPermission: p('report.branch'),
  },
  {
    id: 'audit',
    href: '/audit',
    label: 'Audit log',
    icon: 'shield',
    requiredPermission: p('audit.read'),
  },
  {
    id: 'settings',
    href: '/settings',
    label: 'Settings',
    icon: 'settings',
    requiredPermission: p('org.settings.update:org'),
  },
];

export function labelFor(item: NavItem, locationType: 'clinic' | 'salon'): string {
  return typeof item.label === 'string' ? item.label : item.label[locationType];
}
