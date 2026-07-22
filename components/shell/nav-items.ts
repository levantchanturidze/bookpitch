import type { UserRole } from '@prisma/client';

export type NavItem = {
  id: string;
  href: string;
  label: string | { clinic: string; salon: string };
  icon: 'calendar' | 'users' | 'message' | 'dollar' | 'trending' | 'shield';
  allowedRoles: UserRole[];
};

// Single source of truth for the sidebar + route-level role guards.
// Keep the roles here in sync with the requireRole() calls in each page.tsx.
export const NAV_ITEMS: NavItem[] = [
  {
    id: 'scheduler',
    href: '/scheduler',
    label: 'Scheduler',
    icon: 'calendar',
    allowedRoles: ['owner', 'practitioner', 'receptionist'],
  },
  {
    id: 'patients',
    href: '/patients',
    // Label follows active location type — the prototype's clinic/salon relabel.
    label: { clinic: 'Patients', salon: 'Clients' },
    icon: 'users',
    allowedRoles: ['owner', 'practitioner', 'receptionist'],
  },
  {
    id: 'reminders',
    href: '/reminders',
    label: 'Reminders',
    icon: 'message',
    allowedRoles: ['owner', 'receptionist'],
  },
  {
    id: 'billing',
    href: '/billing',
    label: 'Billing & POS',
    icon: 'dollar',
    allowedRoles: ['owner', 'receptionist'],
  },
  {
    id: 'analytics',
    href: '/analytics',
    label: 'Business intelligence',
    icon: 'trending',
    allowedRoles: ['owner'],
  },
  {
    id: 'audit',
    href: '/audit',
    label: 'Audit log',
    icon: 'shield',
    allowedRoles: ['owner'],
  },
];

export function labelFor(item: NavItem, locationType: 'clinic' | 'salon'): string {
  return typeof item.label === 'string' ? item.label : item.label[locationType];
}
