'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion, AnimatePresence } from 'motion/react';
import {
  Bell,
  Calendar,
  DollarSign,
  Lock,
  LogOut,
  Menu,
  MessageSquare,
  Sparkles,
  Stethoscope,
  TrendingUp,
  Users,
  X,
} from 'lucide-react';
import type { UserRole } from '@prisma/client';

import { NAV_ITEMS, labelFor, type NavItem } from './nav-items';
import { setActiveLocationAction, signOutAction } from './actions';
import { useNotifications } from './useNotifications';
import type { ActiveLocation } from '@/lib/active-location';

type Props = {
  session: { email: string; role: UserRole };
  organizationName: string;
  locations: ActiveLocation[];
  activeLocation: ActiveLocation;
  children: React.ReactNode;
};

const ICON_MAP = {
  calendar: Calendar,
  users: Users,
  message: MessageSquare,
  dollar: DollarSign,
  trending: TrendingUp,
};

function isActivePath(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function Shell({
  session,
  organizationName,
  locations,
  activeLocation,
  children,
}: Props) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const isClinic = activeLocation.type === 'clinic';
  const accent = isClinic ? 'teal' : 'pink';

  return (
    <div className="min-h-screen bg-[#F8FAFC] font-sans text-slate-800">
      {/* -------------------------------------------------------------------- */}
      {/* Header                                                                */}
      {/* -------------------------------------------------------------------- */}
      <header className="sticky top-0 z-40 border-b border-[#E2E8F0] bg-white px-6 py-3.5 sm:px-8">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setMobileOpen(true)}
              className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 lg:hidden"
              aria-label="Open menu"
            >
              <Menu className="h-5 w-5" />
            </button>

            <div className="flex items-center gap-2">
              <div
                className={`rounded-xl p-2 text-white shadow-md ${
                  isClinic ? 'bg-teal-600 shadow-teal-100' : 'bg-pink-600 shadow-pink-100'
                }`}
              >
                {isClinic ? <Stethoscope className="h-5 w-5" /> : <Sparkles className="h-5 w-5" />}
              </div>
              <div className="hidden sm:block">
                <h1 className="font-display text-sm font-extrabold tracking-tight text-slate-900">
                  {activeLocation.name}
                </h1>
                <p className="font-mono text-[10px] text-slate-400">
                  {organizationName} · Operations Portal
                </p>
              </div>
            </div>

            <LocationSwitcher locations={locations} activeLocation={activeLocation} />
          </div>

          <div className="flex items-center gap-2">
            <NotificationBell open={notifOpen} onToggle={() => setNotifOpen((v) => !v)} />
            <UserMenu
              email={session.email}
              role={session.role}
              open={userMenuOpen}
              onToggle={() => setUserMenuOpen((v) => !v)}
            />
          </div>
        </div>
      </header>

      {/* -------------------------------------------------------------------- */}
      {/* Body: sidebar + main                                                  */}
      {/* -------------------------------------------------------------------- */}
      <div className="mx-auto grid max-w-7xl flex-1 grid-cols-1 gap-6 p-4 sm:p-6 lg:grid-cols-12">
        <aside className="hidden lg:col-span-3 lg:block">
          <div className="sticky top-24 rounded-xl border border-[#E2E8F0] bg-white p-5">
            <span className="mb-2 block px-3 font-mono text-[10px] font-bold tracking-widest text-slate-400 uppercase">
              Main Menu
            </span>
            <SidebarNav
              accent={accent}
              role={session.role}
              locationType={activeLocation.type}
              pathname={pathname}
            />
          </div>
        </aside>

        <main className="space-y-6 lg:col-span-9">{children}</main>
      </div>

      {/* -------------------------------------------------------------------- */}
      {/* Mobile drawer                                                         */}
      {/* -------------------------------------------------------------------- */}
      <AnimatePresence>
        {mobileOpen && (
          <>
            <div
              className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs lg:hidden"
              onClick={() => setMobileOpen(false)}
            />
            <motion.div
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="fixed inset-y-0 left-0 z-50 flex w-64 flex-col justify-between border-r border-slate-100 bg-white p-5 shadow-2xl lg:hidden"
            >
              <div>
                <div className="mb-6 flex items-center justify-between border-b border-slate-100 pb-4">
                  <span className="font-display text-sm font-extrabold tracking-tight text-slate-800">
                    {activeLocation.name}
                  </span>
                  <button
                    onClick={() => setMobileOpen(false)}
                    className="rounded-lg p-1 hover:bg-slate-50"
                    aria-label="Close menu"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>
                <SidebarNav
                  accent={accent}
                  role={session.role}
                  locationType={activeLocation.type}
                  pathname={pathname}
                  onNavigate={() => setMobileOpen(false)}
                />
              </div>
              <p className="border-t border-slate-100 pt-4 text-xs text-slate-500">
                {organizationName}
              </p>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar (used by both desktop + mobile)
// ---------------------------------------------------------------------------
function SidebarNav({
  accent,
  role,
  locationType,
  pathname,
  onNavigate,
}: {
  accent: 'teal' | 'pink';
  role: UserRole;
  locationType: 'clinic' | 'salon';
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    <nav className="space-y-1">
      {NAV_ITEMS.map((item) => (
        <SidebarLink
          key={item.id}
          item={item}
          accent={accent}
          allowed={item.allowedRoles.includes(role)}
          active={isActivePath(pathname, item.href)}
          label={labelFor(item, locationType)}
          onNavigate={onNavigate}
        />
      ))}
    </nav>
  );
}

function SidebarLink({
  item,
  accent,
  allowed,
  active,
  label,
  onNavigate,
}: {
  item: NavItem;
  accent: 'teal' | 'pink';
  allowed: boolean;
  active: boolean;
  label: string;
  onNavigate?: () => void;
}) {
  const Icon = ICON_MAP[item.icon];
  const activeClass =
    accent === 'teal'
      ? 'bg-slate-100 text-slate-900 border-l-[3px] border-teal-600 rounded-l-none font-bold'
      : 'bg-slate-100 text-slate-900 border-l-[3px] border-pink-600 rounded-l-none font-bold';
  const hoverClass =
    accent === 'teal'
      ? 'hover:bg-slate-100 hover:text-teal-800'
      : 'hover:bg-slate-100 hover:text-pink-800';

  const shared =
    'w-full flex items-center justify-between px-4 py-2.5 rounded-lg text-[13px] font-medium transition';

  if (!allowed) {
    return (
      <div
        className={`${shared} cursor-not-allowed bg-slate-50/50 text-slate-300`}
        aria-disabled
        title="Locked by your role"
      >
        <span className="flex items-center gap-2.5">
          <Icon className="h-4 w-4" />
          {label}
        </span>
        <Lock className="h-3 w-3 text-slate-400" />
      </div>
    );
  }

  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      className={`${shared} ${active ? activeClass : `text-[#64748B] ${hoverClass}`}`}
    >
      <span className="flex items-center gap-2.5">
        <Icon className="h-4 w-4" />
        {label}
      </span>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Location switcher (clinic ⇄ salon; extends to N locations later)
// ---------------------------------------------------------------------------
function LocationSwitcher({
  locations,
  activeLocation,
}: {
  locations: ActiveLocation[];
  activeLocation: ActiveLocation;
}) {
  if (locations.length < 2) return null;

  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-slate-200 bg-slate-100 p-0.5">
      {locations.map((loc) => {
        const active = loc.id === activeLocation.id;
        const activeColor =
          loc.type === 'clinic' ? 'bg-white text-teal-800 shadow-sm' : 'bg-white text-pink-800 shadow-sm';
        return (
          <form key={loc.id} action={setActiveLocationAction.bind(null, loc.id)}>
            <button
              type="submit"
              className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-[10px] font-bold transition ${
                active ? activeColor : 'text-slate-500 hover:text-slate-700'
              }`}
              title={`Switch to ${loc.name}`}
            >
              {loc.type === 'clinic' ? '🏥' : '💅'} {loc.name}
            </button>
          </form>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notification bell — live feed via SSE (P3.1).
// ---------------------------------------------------------------------------
function NotificationBell({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { items, unreadCount, markAllRead, clear } = useNotifications();
  return (
    <div className="relative">
      <button
        onClick={onToggle}
        className="relative rounded-xl bg-slate-50 p-2 text-slate-600 transition hover:bg-slate-100"
        title="Notifications"
        aria-label="Notifications"
      >
        <Bell className="h-4 w-4" />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full border-2 border-white bg-rose-500 px-1 font-mono text-[8px] font-bold text-white">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>
      <AnimatePresence>
        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={onToggle} />
            <motion.div
              initial={{ opacity: 0, y: 10, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.95 }}
              className="absolute right-0 z-50 mt-2 w-80 rounded-2xl border border-slate-100 bg-white p-4 shadow-xl"
            >
              <div className="mb-3 flex items-center justify-between border-b border-slate-100 pb-3">
                <p className="text-xs font-bold text-slate-800">Operational Log</p>
                <div className="flex gap-2">
                  <button
                    onClick={markAllRead}
                    className="text-[10px] text-teal-600 hover:underline"
                  >
                    Mark all read
                  </button>
                  <button
                    onClick={clear}
                    className="text-[10px] text-slate-400 hover:text-slate-600"
                  >
                    Clear
                  </button>
                </div>
              </div>
              <div className="max-h-[280px] space-y-2 overflow-y-auto pr-1">
                {items.length === 0 ? (
                  <div className="py-8 text-center text-xs text-slate-400">
                    No recent activity.
                  </div>
                ) : (
                  items.map((n) => (
                    <div
                      key={n.id}
                      className={`rounded-xl border p-2.5 text-[11px] leading-relaxed transition ${
                        n.read
                          ? 'border-slate-100 bg-slate-50 text-slate-500'
                          : 'border-teal-100 bg-teal-50/40 font-medium text-slate-800'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-1">
                        <span className="text-[11px] font-bold text-slate-800">
                          {n.title}
                        </span>
                        <span className="font-mono text-[9px] text-slate-400">
                          {formatRelative(n.createdAt)}
                        </span>
                      </div>
                      {n.body && (
                        <p className="mt-0.5 text-[10px] text-slate-500">{n.body}</p>
                      )}
                    </div>
                  ))
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const secs = Math.max(0, Math.round((now - then) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  if (secs < 86_400) return `${Math.round(secs / 3600)}h`;
  return `${Math.round(secs / 86_400)}d`;
}

// ---------------------------------------------------------------------------
// User menu — email, role badge, sign out
// ---------------------------------------------------------------------------
function UserMenu({
  email,
  role,
  open,
  onToggle,
}: {
  email: string;
  role: UserRole;
  open: boolean;
  onToggle: () => void;
}) {
  const initials = email.slice(0, 2).toUpperCase();
  return (
    <div className="relative">
      <button
        onClick={onToggle}
        className="flex items-center gap-2 rounded-xl bg-slate-50 px-2 py-1.5 text-xs font-bold text-slate-700 transition hover:bg-slate-100"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-900 font-mono text-[10px] text-white">
          {initials}
        </span>
        <span className="hidden font-mono text-[10px] tracking-wider text-slate-400 uppercase sm:inline">
          {role}
        </span>
      </button>
      <AnimatePresence>
        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={onToggle} />
            <motion.div
              initial={{ opacity: 0, y: 10, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.95 }}
              className="absolute right-0 z-50 mt-2 w-56 rounded-2xl border border-slate-100 bg-white p-3 shadow-xl"
            >
              <div className="border-b border-slate-100 pb-3">
                <p className="text-xs font-bold text-slate-800">{email}</p>
                <p className="mt-0.5 font-mono text-[10px] tracking-wider text-slate-400 uppercase">
                  {role}
                </p>
              </div>
              <form action={signOutAction}>
                <button
                  type="submit"
                  className="mt-2 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs text-slate-600 transition hover:bg-slate-50 hover:text-slate-900"
                >
                  <LogOut className="h-4 w-4" />
                  Sign out
                </button>
              </form>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
