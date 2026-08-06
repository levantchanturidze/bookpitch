import { useState, useMemo } from 'react';
import {
  Send,
  CheckCircle,
  AlertCircle,
  Sparkles,
  MessageSquare,
  Mail,
  RefreshCw,
  Clock,
  Play,
} from 'lucide-react';
import { Appointment, Patient, Staff, WorkspaceMode } from '@/lib/types';
import { motion } from 'motion/react';

interface RemindersSystemProps {
  mode: WorkspaceMode;
  appointments: Appointment[];
  patients: Patient[];
  staff: Staff[];
  onTriggerReminder: (appointmentId: string) => void;
}

export default function RemindersSystem({
  mode,
  appointments,
  patients,
  staff,
  onTriggerReminder,
}: RemindersSystemProps) {
  const isClinic = mode === 'clinic';
  const staffLabel = isClinic ? 'Doctor' : 'Stylist';
  const patientLabel = isClinic ? 'Patient' : 'Client';

  // Templates
  const [smsTemplate, setSmsTemplate] = useState(
    isClinic
      ? 'Hi {PatientName}, this is a friendly reminder of your appointment with {StaffName} for {ServiceName} on {Date} at {Time}. Please call if you need to reschedule.'
      : 'Hi {PatientName}, we look forward to seeing you for your {ServiceName} with {StaffName} on {Date} at {Time}! Get ready to shine!',
  );

  const [emailTemplate, setEmailTemplate] = useState(
    isClinic
      ? 'Dear {PatientName},\n\nThis is a confirmation of your upcoming clinical appointment:\n- Practitioner: {StaffName}\n- Specialty: {ServiceName}\n- Schedule: {Date} at {Time}\n\nPlease bring any insurance details and arrive 10 minutes early.\n\nWarm regards,\nHealth Clinic Support'
      : 'Hello beautiful {PatientName},\n\nYour luxury salon session is scheduled!\n- Style Consultant: {StaffName}\n- Service Chosen: {ServiceName}\n- Roster Slot: {Date} at {Time}\n\nWe cannot wait to treat you!\n\nBest,\nSleek Salon & Spa Team',
  );

  // Filter out cancelled appointments for future dates (July 22 onwards)
  const pendingReminders = useMemo(() => {
    return appointments.filter((a) => a.date >= '2026-07-21' && a.status !== 'cancelled');
  }, [appointments]);

  // Preview helper function
  const renderPreview = (template: string, app: Appointment) => {
    const patient = patients.find((p) => p.id === app.patientId);
    const st = staff.find((s) => s.id === app.staffId);

    return template
      .replace(/{PatientName}/g, patient?.name || '[Name]')
      .replace(/{StaffName}/g, st?.name || '[Staff]')
      .replace(/{ServiceName}/g, app.service)
      .replace(/{Date}/g, app.date)
      .replace(/{Time}/g, app.time);
  };

  const [activeTab, setActiveTab] = useState<'sms' | 'email'>('sms');
  const [dispatchLogs, setDispatchLogs] = useState<{ id: string; msg: string; time: string }[]>([]);

  const handleSimulateDispatch = (app: Appointment) => {
    const text = renderPreview(activeTab === 'sms' ? smsTemplate : emailTemplate, app);
    const timeStr = new Date().toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    });

    setDispatchLogs((prev) => [
      {
        id: Math.random().toString(),
        msg: `Dispatched ${activeTab.toUpperCase()} to ${patients.find((p) => p.id === app.patientId)?.name}: "${text.substring(0, 50)}..."`,
        time: timeStr,
      },
      ...prev,
    ]);

    // Fire the callback to update the reminder status in global state
    onTriggerReminder(app.id);
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12" id="reminders-system-root">
      {/* Template Editors (7 Columns) */}
      <div
        className="flex flex-col rounded-xl border border-slate-200 bg-white p-6 lg:col-span-7"
        id="reminders-templates-card"
      >
        <div className="mb-5 flex items-center justify-between">
          <div>
            <h3 className="text-base font-bold text-slate-800">Automated Reminder Engine</h3>
            <p className="text-[10px] text-slate-400">
              Configure text parameters with active placeholders
            </p>
          </div>

          <div className="flex rounded-lg border border-slate-100 bg-slate-50 p-0.5">
            <button
              onClick={() => setActiveTab('sms')}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                activeTab === 'sms'
                  ? 'bg-white text-slate-800 shadow-sm'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              <MessageSquare className="h-3.5 w-3.5" /> SMS Template
            </button>
            <button
              onClick={() => setActiveTab('email')}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                activeTab === 'email'
                  ? 'bg-white text-slate-800 shadow-sm'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              <Mail className="h-3.5 w-3.5" /> Email Template
            </button>
          </div>
        </div>

        {/* Editor Body */}
        <div className="flex flex-1 flex-col space-y-4">
          {activeTab === 'sms' ? (
            <div className="flex flex-1 flex-col">
              <label className="mb-1 block text-xs font-bold text-slate-500">
                SMS Message Template
              </label>
              <textarea
                value={smsTemplate}
                onChange={(e) => setSmsTemplate(e.target.value)}
                className="min-h-[140px] w-full flex-1 resize-none rounded-xl border border-slate-200 bg-slate-50 p-3 font-sans text-xs text-slate-700 focus:ring-1 focus:ring-teal-500 focus:outline-none"
              />
              <span className="mt-2 font-mono text-[10px] text-slate-400">
                SMS limits apply. Try to keep templates brief to fit in single SMS segments.
              </span>
            </div>
          ) : (
            <div className="flex flex-1 flex-col">
              <label className="mb-1 block text-xs font-bold text-slate-500">
                HTML Email Template Body
              </label>
              <textarea
                value={emailTemplate}
                onChange={(e) => setEmailTemplate(e.target.value)}
                className="min-h-[140px] w-full flex-1 resize-none rounded-xl border border-slate-200 bg-slate-50 p-3 font-mono text-xs leading-relaxed text-slate-700 focus:ring-1 focus:ring-teal-500 focus:outline-none"
              />
            </div>
          )}

          {/* Placeholders Guide */}
          <div className="flex flex-col gap-1.5 rounded-xl border border-slate-100 bg-slate-50/50 p-3.5">
            <span className="font-mono text-[10px] font-bold tracking-wider text-slate-400 uppercase">
              Dynamic Placeholders Available
            </span>
            <div className="flex flex-wrap gap-2 font-mono text-[10px] text-slate-600">
              <span className="rounded border bg-white px-1.5 py-0.5">{'{PatientName}'}</span>
              <span className="rounded border bg-white px-1.5 py-0.5">{'{StaffName}'}</span>
              <span className="rounded border bg-white px-1.5 py-0.5">{'{ServiceName}'}</span>
              <span className="rounded border bg-white px-1.5 py-0.5">{'{Date}'}</span>
              <span className="rounded border bg-white px-1.5 py-0.5">{'{Time}'}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Roster Queue & Dispatch Simulator (5 Columns) */}
      <div
        className="flex h-[460px] flex-col rounded-xl border border-slate-200 bg-white p-6 lg:col-span-5"
        id="reminders-queue-card"
      >
        <div>
          <h3 className="text-base font-bold text-slate-800">Dispatch Queue</h3>
          <p className="text-[10px] text-slate-400">
            Simulate instant manual notifications dispatch
          </p>
        </div>

        {/* Queue listings */}
        <div className="mt-4 flex-1 space-y-3 overflow-y-auto pr-1">
          {pendingReminders.map((app) => {
            const patient = patients.find((p) => p.id === app.patientId);
            return (
              <div
                key={app.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 p-3 text-xs"
              >
                <div className="min-w-0">
                  <div className="mb-1 flex items-center gap-1.5">
                    <strong className="block truncate text-slate-800">{patient?.name}</strong>
                    {app.reminderSent ? (
                      <span className="rounded-md border border-emerald-100 bg-emerald-50 px-1 font-mono text-[9px] text-emerald-600">
                        Sent
                      </span>
                    ) : (
                      <span className="rounded-md border border-amber-100 bg-amber-50 px-1 font-mono text-[9px] text-amber-600">
                        Unsent
                      </span>
                    )}
                  </div>
                  <p className="truncate text-[10px] font-medium text-slate-500">{app.service}</p>
                  <p className="mt-1 font-mono text-[9px] text-slate-400">
                    {app.date} • {app.time}
                  </p>
                </div>

                <button
                  onClick={() => handleSimulateDispatch(app)}
                  className={`flex shrink-0 items-center gap-1 rounded-lg px-3 py-1.5 text-[11px] font-bold text-white shadow-sm transition ${
                    isClinic ? 'bg-teal-600 hover:bg-teal-700' : 'bg-pink-600 hover:bg-pink-700'
                  }`}
                  id={`reminder-dispatch-btn-${app.id}`}
                >
                  <Play className="h-3 w-3 fill-current" /> Dispatch
                </button>
              </div>
            );
          })}

          {pendingReminders.length === 0 && (
            <p className="py-12 text-center text-xs text-slate-400">
              No upcoming scheduled appointments.
            </p>
          )}
        </div>

        {/* Recent logs */}
        <div className="mt-3 border-t border-slate-100 pt-3">
          <span className="mb-1 block font-mono text-[9px] font-bold tracking-wide text-slate-400 uppercase">
            Dispatch Log
          </span>
          <div className="h-[90px] space-y-1.5 overflow-y-auto rounded-lg border border-slate-100 bg-slate-50 p-2.5 font-mono text-[9px] text-slate-500">
            {dispatchLogs.map((log) => (
              <div
                key={log.id}
                className="flex justify-between gap-2 border-b border-slate-100/50 pb-1"
              >
                <span className="truncate font-sans text-slate-600">{log.msg}</span>
                <span className="shrink-0 text-slate-400">{log.time}</span>
              </div>
            ))}
            {dispatchLogs.length === 0 && (
              <span className="block py-6 text-center text-slate-400">
                Logs will render upon dispatch events.
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
