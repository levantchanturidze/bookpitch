'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Building,
  Users,
  Wrench,
  UserCog,
  CreditCard,
  ShieldCheck,
  FileText,
  KeyRound,
} from 'lucide-react';

const TABS = [
  { href: '/settings/locations', label: 'Locations', icon: Building },
  { href: '/settings/staff', label: 'Staff', icon: Users },
  { href: '/settings/services', label: 'Services', icon: Wrench },
  { href: '/settings/members', label: 'Members', icon: UserCog },
  { href: '/settings/permissions', label: 'Permissions', icon: KeyRound },
  { href: '/settings/billing', label: 'Billing', icon: CreditCard },
  { href: '/settings/privacy', label: 'Privacy', icon: ShieldCheck },
  { href: '/settings/insurance', label: 'Insurance', icon: FileText },
];

export default function TabsNav() {
  const pathname = usePathname() ?? '';
  return (
    <nav className="flex items-center gap-1 rounded-xl border border-slate-200 bg-white p-1">
      {TABS.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              active
                ? 'bg-slate-900 text-white'
                : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
