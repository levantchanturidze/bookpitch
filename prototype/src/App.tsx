import { useState, useEffect, useMemo } from 'react';
import {
  Calendar,
  Users,
  MessageSquare,
  DollarSign,
  TrendingUp,
  Wifi,
  WifiOff,
  Bell,
  Lock,
  Menu,
  X,
  Stethoscope,
  Sparkles,
  RefreshCw,
  Heart,
  CheckCircle,
  Clock,
  LogOut,
  ChevronRight,
  ShieldAlert,
  HardDrive
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// Data and components
import {
  INITIAL_APPOINTMENTS,
  INITIAL_PATIENTS,
  INITIAL_STAFF,
  INITIAL_NOTIFICATIONS,
  TODAY_STR
} from './data';
import { Appointment, Patient, Staff, AppNotification, SyncQueueItem, UserRole, WorkspaceMode } from './types';

import CalendarView from './components/CalendarView';
import PatientDatabase from './components/PatientDatabase';
import AnalyticsDashboard from './components/AnalyticsDashboard';
import RemindersSystem from './components/RemindersSystem';
import CheckoutPayment from './components/CheckoutPayment';
import OfflineManager from './components/OfflineManager';

export default function App() {
  // --- STATE PERSISTENCE & INITIALIZATION ---
  const [mode, setMode] = useState<WorkspaceMode>(() => {
    const saved = localStorage.getItem('booking_mode');
    return (saved as WorkspaceMode) || 'clinic';
  });

  const [role, setRole] = useState<UserRole>(() => {
    const saved = localStorage.getItem('booking_role');
    return (saved as UserRole) || 'owner';
  });

  const [appointments, setAppointments] = useState<Appointment[]>(() => {
    const saved = localStorage.getItem('booking_appointments');
    return saved ? JSON.parse(saved) : INITIAL_APPOINTMENTS;
  });

  const [patients, setPatients] = useState<Patient[]>(() => {
    const saved = localStorage.getItem('booking_patients');
    return saved ? JSON.parse(saved) : INITIAL_PATIENTS;
  });

  const [staff] = useState<Staff[]>(INITIAL_STAFF);

  const [notifications, setNotifications] = useState<AppNotification[]>(() => {
    const saved = localStorage.getItem('booking_notifications');
    return saved ? JSON.parse(saved) : INITIAL_NOTIFICATIONS;
  });

  const [isOnline, setIsOnline] = useState<boolean>(() => {
    const saved = localStorage.getItem('booking_online');
    return saved ? saved === 'true' : true;
  });

  const [syncQueue, setSyncQueue] = useState<SyncQueueItem[]>(() => {
    const saved = localStorage.getItem('booking_sync_queue');
    return saved ? JSON.parse(saved) : [];
  });

  const [activeTab, setActiveTab] = useState<string>('calendar');
  const [selectedPatientId, setSelectedPatientId] = useState<string | undefined>(undefined);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isNotifOpen, setIsNotifOpen] = useState(false);

  // Sync to localStorage
  useEffect(() => {
    localStorage.setItem('booking_mode', mode);
  }, [mode]);

  useEffect(() => {
    localStorage.setItem('booking_role', role);
  }, [role]);

  useEffect(() => {
    localStorage.setItem('booking_appointments', JSON.stringify(appointments));
  }, [appointments]);

  useEffect(() => {
    localStorage.setItem('booking_patients', JSON.stringify(patients));
  }, [patients]);

  useEffect(() => {
    localStorage.setItem('booking_notifications', JSON.stringify(notifications));
  }, [notifications]);

  useEffect(() => {
    localStorage.setItem('booking_online', String(isOnline));
  }, [isOnline]);

  useEffect(() => {
    localStorage.setItem('booking_sync_queue', JSON.stringify(syncQueue));
  }, [syncQueue]);


  // --- DYNAMIC TERM CONFIGURATIONS ---
  const isClinic = mode === 'clinic';
  const themeColor = isClinic ? 'teal' : 'pink';
  const themeBgHover = isClinic ? 'hover:bg-slate-100 hover:text-teal-800' : 'hover:bg-slate-100 hover:text-pink-800';
  const themeActiveTabClass = isClinic
    ? 'bg-slate-100 text-slate-900 border-l-[3px] border-teal-600 rounded-r-xl rounded-l-none font-bold'
    : 'bg-slate-100 text-slate-900 border-l-[3px] border-pink-600 rounded-r-xl rounded-l-none font-bold';
  const themeTextAccent = isClinic ? 'text-teal-600' : 'text-pink-600';
  const themeBorderAccent = isClinic ? 'border-teal-500' : 'border-pink-500';


  // --- CORE BUSINESS ACTIONS ---

  // Add Appointment
  const handleAddAppointment = (newApp: Omit<Appointment, 'id'>) => {
    const id = 'a' + (appointments.length + 10);
    const appointmentRecord: Appointment = { ...newApp, id };

    setAppointments((prev) => [appointmentRecord, ...prev]);

    // Notification
    const patientName = patients.find((p) => p.id === newApp.patientId)?.name || 'Someone';
    const newNotif: AppNotification = {
      id: 'n' + (notifications.length + 10),
      title: 'Appointment Booked',
      message: `${patientName} scheduled for ${newApp.service} at ${newApp.time}.`,
      time: 'Just now',
      type: 'booking',
      read: false,
    };
    setNotifications((prev) => [newNotif, ...prev]);

    // Sync Queueing if offline
    if (!isOnline) {
      const queueItem: SyncQueueItem = {
        id: Math.random().toString(),
        action: 'create',
        entity: 'appointment',
        data: appointmentRecord,
        timestamp: new Date().toLocaleTimeString(),
      };
      setSyncQueue((prev) => [...prev, queueItem]);
    }
  };

  // Add Patient
  const handleAddPatient = (newPat: Omit<Patient, 'id' | 'joinedDate' | 'avatar'>) => {
    const id = 'p' + (patients.length + 10);
    const patientRecord: Patient = {
      ...newPat,
      id,
      joinedDate: '2026-07-21',
      avatar: `https://images.unsplash.com/photo-${Math.floor(1500000000000 + Math.random() * 90000000000)}?w=150`,
    };

    setPatients((prev) => [patientRecord, ...prev]);

    const newNotif: AppNotification = {
      id: 'n' + (notifications.length + 10),
      title: 'New Profile Registered',
      message: `${newPat.name} was successfully registered in the database.`,
      time: 'Just now',
      type: 'system',
      read: false,
    };
    setNotifications((prev) => [newNotif, ...prev]);

    if (!isOnline) {
      const queueItem: SyncQueueItem = {
        id: Math.random().toString(),
        action: 'create',
        entity: 'patient',
        data: patientRecord,
        timestamp: new Date().toLocaleTimeString(),
      };
      setSyncQueue((prev) => [...prev, queueItem]);
    }
  };

  // Status Modifiers
  const handleUpdateAppointmentStatus = (id: string, status: Appointment['status']) => {
    setAppointments((prev) =>
      prev.map((app) => (app.id === id ? { ...app, status } : app))
    );

    const app = appointments.find((a) => a.id === id);
    if (!app) return;

    const patientName = patients.find((p) => p.id === app.patientId)?.name || 'Client';
    const newNotif: AppNotification = {
      id: 'n' + (notifications.length + 10),
      title: `Visit Status updated`,
      message: `${patientName}'s visit status was updated to "${status}".`,
      time: 'Just now',
      type: 'booking',
      read: false,
    };
    setNotifications((prev) => [newNotif, ...prev]);
  };

  const handleUpdatePaymentStatus = (id: string, paymentStatus: Appointment['paymentStatus']) => {
    setAppointments((prev) =>
      prev.map((app) => (app.id === id ? { ...app, paymentStatus } : app))
    );

    const app = appointments.find((a) => a.id === id);
    if (!app) return;

    const patientName = patients.find((p) => p.id === app.patientId)?.name || 'Client';
    const newNotif: AppNotification = {
      id: 'n' + (notifications.length + 10),
      title: `Bill Settled`,
      message: `${patientName} completed payment of $${app.price.toFixed(2)}.`,
      time: 'Just now',
      type: 'payment',
      read: false,
    };
    setNotifications((prev) => [newNotif, ...prev]);
  };

  const handleTriggerReminder = (id: string) => {
    setAppointments((prev) =>
      prev.map((app) => (app.id === id ? { ...app, reminderSent: true } : app))
    );

    const app = appointments.find((a) => a.id === id);
    if (!app) return;

    const patientName = patients.find((p) => p.id === app.patientId)?.name || 'Client';
    const newNotif: AppNotification = {
      id: 'n' + (notifications.length + 10),
      title: `SMS Reminder Sent`,
      message: `Automated dispatch confirmed for ${patientName}.`,
      time: 'Just now',
      type: 'reminder',
      read: false,
    };
    setNotifications((prev) => [newNotif, ...prev]);
  };

  // Sync Process
  const handleTriggerSync = () => {
    // Clear out offline queue upon reconnection
    setSyncQueue([]);
    const newNotif: AppNotification = {
      id: 'n' + (notifications.length + 10),
      title: `Cloud Sync Complete`,
      message: `Synchronized transaction histories to primary secure databases.`,
      time: 'Just now',
      type: 'sync',
      read: false,
    };
    setNotifications((prev) => [newNotif, ...prev]);
  };

  // Notifications indicators
  const unreadCount = useMemo(() => {
    return notifications.filter((n) => !n.read).length;
  }, [notifications]);

  const handleMarkAllNotificationsRead = () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  };

  const handleClearNotifications = () => {
    setNotifications([]);
  };

  // Navigate to patient database automatically when clicking details
  const handleSelectPatientRedirect = (patientId: string) => {
    setSelectedPatientId(patientId);
    setActiveTab('patients');
  };


  // --- ROLE-BASED ACCESS CONTROL (RBAC) GATES ---
  const allowedTabs = useMemo(() => {
    if (role === 'owner') {
      return ['calendar', 'patients', 'reminders', 'checkout', 'analytics', 'offline'];
    }
    if (role === 'receptionist') {
      return ['calendar', 'patients', 'reminders', 'checkout', 'offline'];
    }
    // practitioner
    return ['calendar', 'patients', 'offline'];
  }, [role]);

  // Fallback active tab if role swaps and locks current tab
  useEffect(() => {
    if (!allowedTabs.includes(activeTab)) {
      setActiveTab('calendar');
    }
  }, [role, allowedTabs, activeTab]);


  // Navigation list
  const navItems = [
    { id: 'calendar', label: 'Scheduler', icon: Calendar, roles: ['owner', 'practitioner', 'receptionist'] },
    { id: 'patients', label: isClinic ? 'Patients' : 'Clients', icon: Users, roles: ['owner', 'practitioner', 'receptionist'] },
    { id: 'reminders', label: 'Reminders', icon: MessageSquare, roles: ['owner', 'receptionist'] },
    { id: 'checkout', label: 'Billing & POS', icon: DollarSign, roles: ['owner', 'receptionist'] },
    { id: 'analytics', label: 'Business intelligence', icon: TrendingUp, roles: ['owner'] },
    { id: 'offline', label: 'Sync & Backup', icon: HardDrive, roles: ['owner', 'practitioner', 'receptionist'] },
  ];

  return (
    <div className="min-h-screen bg-[#F8FAFC] flex flex-col font-sans text-slate-800" id="applet-master-layout">
      
      {/* 1. TOP HEADER NAVIGATION BAR */}
      <header className="bg-white border-b border-[#E2E8F0] px-6 sm:px-8 py-3.5 sticky top-0 z-40" id="dashboard-top-navbar">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
          
          {/* Logo & Toggle Mode */}
          <div className="flex items-center gap-3">
            <button
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
              className="lg:hidden p-1.5 hover:bg-slate-100 rounded-lg text-slate-500"
              title="Open Navigation Menu"
            >
              <Menu className="h-5 w-5" />
            </button>

            <div className="flex items-center gap-2">
              <div className={`p-2 rounded-xl text-white ${isClinic ? 'bg-teal-600 shadow-teal-100' : 'bg-pink-600 shadow-pink-100'} shadow-md`}>
                {isClinic ? <Stethoscope className="h-5 w-5" /> : <Sparkles className="h-5 w-5" />}
              </div>
              <div className="hidden sm:block">
                <h1 className="text-sm font-extrabold tracking-tight text-slate-900 font-display">
                  {isClinic ? 'Grand Medical Suite' : 'Aurora Salon & Spa'}
                </h1>
                <p className="text-[10px] text-slate-400 font-mono">Operations Portal • v1.1</p>
              </div>
            </div>

            {/* Template Selector Mode switcher */}
            <div className="bg-slate-100 p-0.5 rounded-lg flex items-center gap-0.5 border border-slate-200">
              <button
                onClick={() => setMode('clinic')}
                className={`px-2.5 py-1 text-[10px] font-bold rounded-md transition flex items-center gap-1 ${
                  isClinic ? 'bg-white text-teal-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                }`}
                title="Switch Workspace to Medical Clinic mode"
              >
                🏥 Clinic
              </button>
              <button
                onClick={() => setMode('salon')}
                className={`px-2.5 py-1 text-[10px] font-bold rounded-md transition flex items-center gap-1 ${
                  !isClinic ? 'bg-white text-pink-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                }`}
                title="Switch Workspace to Beauty Salon mode"
              >
                💅 Salon
              </button>
            </div>
          </div>

          {/* Controls: RBAC role switch, network, notifications */}
          <div className="flex items-center gap-3">
            
            {/* Role selector RBAC widget */}
            <div className="hidden md:flex items-center gap-1 bg-slate-50 border border-slate-200 p-1 rounded-lg">
              <span className="text-[9px] font-bold font-mono text-slate-400 px-2 uppercase">Access role:</span>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as UserRole)}
                className="bg-white border-0 text-[10px] font-bold text-slate-700 rounded p-1 shadow-sm focus:ring-1 focus:ring-slate-800 focus:outline-none"
              >
                <option value="owner">👑 Owner (Unrestricted)</option>
                <option value="receptionist">💼 Reception Desk</option>
                <option value="practitioner">🩺 Practitioner / Stylist</option>
              </select>
            </div>

            {/* Connectivity Badge */}
            <div className="flex items-center">
              {isOnline ? (
                <span className="flex items-center gap-1 text-[10px] text-emerald-600 bg-emerald-50 px-2 py-1 rounded-lg border border-emerald-100 font-semibold font-mono">
                  <Wifi className="h-3.5 w-3.5" /> Online
                </span>
              ) : (
                <span className="flex items-center gap-1 text-[10px] text-amber-600 bg-amber-50 px-2 py-1 rounded-lg border border-amber-100 font-semibold font-mono animate-pulse">
                  <WifiOff className="h-3.5 w-3.5" /> Offline
                </span>
              )}
            </div>

            {/* Notifications Alert tray bell */}
            <div className="relative">
              <button
                onClick={() => setIsNotifOpen(!isNotifOpen)}
                className="p-2 bg-slate-50 hover:bg-slate-100 text-slate-600 rounded-xl relative transition"
                title="System Activity Log Notifications"
              >
                <Bell className="h-4.5 w-4.5" />
                {unreadCount > 0 && (
                  <span className="absolute -top-1 -right-1 bg-rose-500 text-white font-mono font-bold text-[8px] h-4 w-4 rounded-full flex items-center justify-center border-2 border-white animate-bounce">
                    {unreadCount}
                  </span>
                )}
              </button>

              {/* Notification dropdown popover */}
              <AnimatePresence>
                {isNotifOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setIsNotifOpen(false)} />
                    <motion.div
                      initial={{ opacity: 0, y: 10, scale: 0.95 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 10, scale: 0.95 }}
                      className="absolute right-0 mt-2 w-80 bg-white border border-slate-100 rounded-2xl shadow-xl z-50 p-4"
                    >
                      <div className="flex items-center justify-between pb-3 border-b border-slate-100 mb-3">
                        <span className="text-xs font-bold text-slate-800">Operational Log</span>
                        <div className="flex gap-2">
                          <button
                            onClick={handleMarkAllNotificationsRead}
                            className="text-[10px] text-teal-600 hover:underline"
                          >
                            Mark Read
                          </button>
                          <button
                            onClick={handleClearNotifications}
                            className="text-[10px] text-slate-400 hover:text-slate-600"
                          >
                            Clear
                          </button>
                        </div>
                      </div>

                      <div className="space-y-2.5 max-h-[240px] overflow-y-auto pr-1">
                        {notifications.length === 0 ? (
                          <div className="text-center py-8 text-slate-400 text-xs">
                            No recent logs reported.
                          </div>
                        ) : (
                          notifications.map((notif) => (
                            <div
                              key={notif.id}
                              className={`p-2.5 rounded-xl border text-[11px] leading-relaxed transition ${
                                notif.read ? 'bg-slate-50 border-slate-100 text-slate-500' : 'bg-teal-50/40 border-teal-100 text-slate-800 font-medium'
                              }`}
                            >
                              <div className="flex justify-between items-start gap-1">
                                <span className="font-bold text-slate-800 text-[11px] block">{notif.title}</span>
                                <span className="text-[9px] text-slate-400 font-mono">{notif.time}</span>
                              </div>
                              <p className="mt-0.5 text-[10px] text-slate-500">{notif.message}</p>
                            </div>
                          ))
                        )}
                      </div>
                    </motion.div>
                  </>
                )}
              </AnimatePresence>
            </div>

          </div>
        </div>
      </header>

      {/* ROLBASED RESTRICTIONS BANNER IN MOBILE VIEW */}
      <div className="md:hidden bg-slate-100 border-b border-slate-200 px-4 py-2 flex items-center justify-between text-xs text-slate-700">
        <span className="font-semibold text-[10px]">Access Roster:</span>
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as UserRole)}
          className="bg-white border text-[10px] font-bold text-slate-700 rounded p-1 shadow-sm"
        >
          <option value="owner">👑 Owner (All Views)</option>
          <option value="receptionist">💼 Reception Desk</option>
          <option value="practitioner">🩺 Practitioner / Stylist</option>
        </select>
      </div>

      {/* 2. MAIN CORE CONTENT WRAPPER */}
      <div className="flex-1 max-w-7xl w-full mx-auto grid grid-cols-1 lg:grid-cols-12 p-4 sm:p-6 gap-6" id="dashboard-content-grid">
        
        {/* SIDE BAR NAVIGATION DRAWER (3 Columns on large screens) */}
        <aside className="lg:col-span-3 hidden lg:block" id="desktop-sidebar">
          <div className="bg-white rounded-xl border border-[#E2E8F0] p-5 sticky top-24 space-y-6">
            
            <div className="space-y-1">
              <span className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-widest block px-3">
                Main Menu
              </span>
              <nav className="space-y-1" id="desktop-side-nav">
                {navItems.map((item) => {
                  const isTabAllowed = item.roles.includes(role);
                  const Icon = item.icon;
                  const isActive = activeTab === item.id;

                  return (
                    <button
                      key={item.id}
                      onClick={() => {
                        if (isTabAllowed) {
                          setActiveTab(item.id);
                          setSelectedPatientId(undefined); // Clear deep link
                        }
                      }}
                      className={`w-full flex items-center justify-between px-4 py-2.5 rounded-lg text-xs sm:text-[13px] font-medium transition relative ${
                        isActive
                          ? themeActiveTabClass
                          : isTabAllowed
                            ? `text-[#64748B] ${themeBgHover}`
                            : 'text-slate-300 cursor-not-allowed bg-slate-50/50'
                      }`}
                      id={`sidebar-nav-${item.id}`}
                    >
                      <span className="flex items-center gap-2.5">
                        <Icon className="h-4.5 w-4.5" />
                        {item.label}
                      </span>
                      {!isTabAllowed && (
                        <Lock className="h-3 w-3 text-slate-400" title="Locked by Access Control Role" />
                      )}
                    </button>
                  );
                })}
              </nav>
            </div>

            {/* Micro Quick Statistics Badge */}
            <div className="border-t border-slate-100 pt-4 px-3 space-y-3">
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-slate-400" />
                <div>
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Operational Day</span>
                  <span className="text-xs font-bold text-slate-700">Tuesday, Jul 21, 2026</span>
                </div>
              </div>

              {/* Offline buffer indicator */}
              {syncQueue.length > 0 && (
                <div className="p-2.5 bg-amber-50 border border-amber-100 rounded-xl flex items-center gap-2 text-[11px] text-amber-800">
                  <RefreshCw className="h-3.5 w-3.5 animate-spin text-amber-600" />
                  <span>{syncQueue.length} edits queued offline</span>
                </div>
              )}
            </div>

          </div>
        </aside>

        {/* MOBILE OVERLAY NAVIGATION SIDE BAR */}
        <AnimatePresence>
          {isMobileMenuOpen && (
            <>
              {/* Backdrop */}
              <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs z-50 lg:hidden" onClick={() => setIsMobileMenuOpen(false)} />
              <motion.div
                initial={{ x: '-100%' }}
                animate={{ x: 0 }}
                exit={{ x: '-100%' }}
                transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                className="fixed top-0 bottom-0 left-0 w-64 bg-white border-r border-slate-100 shadow-2xl z-50 p-5 flex flex-col justify-between"
              >
                <div className="space-y-6">
                  <div className="flex items-center justify-between pb-4 border-b border-slate-100">
                    <span className="text-sm font-extrabold tracking-tight text-slate-800 font-display">
                      {isClinic ? 'Grand Medical Suite' : 'Aurora Salon & Spa'}
                    </span>
                    <button onClick={() => setIsMobileMenuOpen(false)} className="p-1 hover:bg-slate-50 rounded-lg">
                      <X className="h-5 w-5" />
                    </button>
                  </div>

                  <nav className="space-y-1">
                    {navItems.map((item) => {
                      const isTabAllowed = item.roles.includes(role);
                      const Icon = item.icon;
                      const isActive = activeTab === item.id;

                      return (
                        <button
                          key={item.id}
                          onClick={() => {
                            if (isTabAllowed) {
                              setActiveTab(item.id);
                              setSelectedPatientId(undefined);
                              setIsMobileMenuOpen(false);
                            }
                          }}
                          className={`w-full flex items-center justify-between px-4 py-2.5 rounded-lg text-sm font-medium transition ${
                            isActive
                              ? themeActiveTabClass
                              : isTabAllowed
                                ? `text-[#64748B] ${themeBgHover}`
                                : 'text-slate-300 cursor-not-allowed bg-slate-50/50'
                          }`}
                        >
                          <span className="flex items-center gap-2.5">
                            <Icon className="h-5 w-5" />
                            {item.label}
                          </span>
                          {!isTabAllowed && <Lock className="h-3.5 w-3.5 text-slate-300" />}
                        </button>
                      );
                    })}
                  </nav>
                </div>

                <div className="border-t border-slate-100 pt-4 flex items-center gap-2.5 text-xs text-slate-500">
                  <Clock className="h-4 w-4" />
                  <span>Tuesday, Jul 21, 2026</span>
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>

        {/* 3. PRIMARY CONTENT DESK (9 Columns on large screens) */}
        <main className="lg:col-span-9 space-y-6" id="primary-content-viewport">
          
          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.15 }}
              id="active-tab-motion-container"
            >
              
              {/* Access Restrained Gate check (extra security layer fallback) */}
              {!allowedTabs.includes(activeTab) ? (
                <div className="bg-white p-12 rounded-2xl border border-slate-100 shadow-sm text-center py-20 flex flex-col items-center justify-center space-y-4">
                  <div className="p-4 bg-rose-50 text-rose-600 rounded-full">
                    <ShieldAlert className="h-8 w-8 stroke-[2.5]" />
                  </div>
                  <div>
                    <h3 className="text-base font-extrabold text-slate-800">Operational Access Lock</h3>
                    <p className="text-xs text-slate-500 max-w-sm mx-auto mt-1 leading-relaxed">
                      Your current credential role <strong>({role.toUpperCase()})</strong> is restricted from accessing this business intelligence module for compliance security.
                    </p>
                  </div>
                  <div className="bg-slate-50 border border-slate-100 p-3.5 rounded-xl text-[10px] text-slate-500 font-mono max-w-md">
                    REASON: Role based access control (RBAC) locks billing settlements and organizational charts for desk operations. Switch role at the top menu to view.
                  </div>
                </div>
              ) : (
                <>
                  {/* CALENDAR SCHEDULER VIEW */}
                  {activeTab === 'calendar' && (
                    <CalendarView
                      mode={mode}
                      appointments={appointments}
                      patients={patients}
                      staff={staff}
                      onAddAppointment={handleAddAppointment}
                      onUpdateAppointmentStatus={handleUpdateAppointmentStatus}
                      onUpdatePaymentStatus={handleUpdatePaymentStatus}
                      onSelectPatient={handleSelectPatientRedirect}
                    />
                  )}

                  {/* PATIENT DATABASE VIEW */}
                  {activeTab === 'patients' && (
                    <PatientDatabase
                      mode={mode}
                      patients={patients}
                      appointments={appointments}
                      onAddPatient={handleAddPatient}
                      selectedPatientId={selectedPatientId}
                    />
                  )}

                  {/* REMINDERS DISPATCH VIEW */}
                  {activeTab === 'reminders' && (
                    <RemindersSystem
                      mode={mode}
                      appointments={appointments}
                      patients={patients}
                      staff={staff}
                      onTriggerReminder={handleTriggerReminder}
                    />
                  )}

                  {/* CHECKOUT PAYMENT TERMINAL VIEW */}
                  {activeTab === 'checkout' && (
                    <CheckoutPayment
                      mode={mode}
                      appointments={appointments}
                      patients={patients}
                      onCompletePayment={(appId) => handleUpdatePaymentStatus(appId, 'paid')}
                    />
                  )}

                  {/* ANALYTICS BUSINESS INTELLIGENCE VIEW */}
                  {activeTab === 'analytics' && (
                    <AnalyticsDashboard
                      mode={mode}
                      appointments={appointments}
                      staff={staff}
                    />
                  )}

                  {/* OFFLINE CONFIG VIEW */}
                  {activeTab === 'offline' && (
                    <OfflineManager
                      isOnline={isOnline}
                      onToggleOnline={() => setIsOnline(!isOnline)}
                      syncQueue={syncQueue}
                      onTriggerSync={handleTriggerSync}
                    />
                  )}
                </>
              )}

            </motion.div>
          </AnimatePresence>

        </main>

      </div>

      {/* FOOTER */}
      <footer className="bg-white border-t border-slate-100 py-4 text-center mt-auto" id="dashboard-footer-info">
        <span className="text-[10px] font-mono text-slate-400">
          Secure Cloud Operations Suite • Verified SSL SHA-256 • Grand Medical & Aurora Spa Group
        </span>
      </footer>

    </div>
  );
}
