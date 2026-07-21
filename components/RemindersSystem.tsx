import { useState, useMemo } from 'react';
import { Send, CheckCircle, AlertCircle, Sparkles, MessageSquare, Mail, RefreshCw, Clock, Play } from 'lucide-react';
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
      : 'Hi {PatientName}, we look forward to seeing you for your {ServiceName} with {StaffName} on {Date} at {Time}! Get ready to shine!'
  );

  const [emailTemplate, setEmailTemplate] = useState(
    isClinic
      ? 'Dear {PatientName},\n\nThis is a confirmation of your upcoming clinical appointment:\n- Practitioner: {StaffName}\n- Specialty: {ServiceName}\n- Schedule: {Date} at {Time}\n\nPlease bring any insurance details and arrive 10 minutes early.\n\nWarm regards,\nHealth Clinic Support'
      : 'Hello beautiful {PatientName},\n\nYour luxury salon session is scheduled!\n- Style Consultant: {StaffName}\n- Service Chosen: {ServiceName}\n- Roster Slot: {Date} at {Time}\n\nWe cannot wait to treat you!\n\nBest,\nSleek Salon & Spa Team'
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
    const timeStr = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });

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
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6" id="reminders-system-root">
      {/* Template Editors (7 Columns) */}
      <div className="lg:col-span-7 bg-white p-6 rounded-xl border border-slate-200 flex flex-col" id="reminders-templates-card">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h3 className="text-base font-bold text-slate-800">Automated Reminder Engine</h3>
            <p className="text-[10px] text-slate-400">Configure text parameters with active placeholders</p>
          </div>

          <div className="flex border border-slate-100 rounded-lg p-0.5 bg-slate-50">
            <button
              onClick={() => setActiveTab('sms')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition ${
                activeTab === 'sms' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              <MessageSquare className="h-3.5 w-3.5" /> SMS Template
            </button>
            <button
              onClick={() => setActiveTab('email')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition ${
                activeTab === 'email' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              <Mail className="h-3.5 w-3.5" /> Email Template
            </button>
          </div>
        </div>

        {/* Editor Body */}
        <div className="space-y-4 flex-1 flex flex-col">
          {activeTab === 'sms' ? (
            <div className="flex-1 flex flex-col">
              <label className="text-xs text-slate-500 font-bold block mb-1">SMS Message Template</label>
              <textarea
                value={smsTemplate}
                onChange={(e) => setSmsTemplate(e.target.value)}
                className="w-full flex-1 min-h-[140px] bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs text-slate-700 font-sans focus:outline-none focus:ring-1 focus:ring-teal-500 resize-none"
              />
              <span className="text-[10px] text-slate-400 mt-2 font-mono">
                SMS limits apply. Try to keep templates brief to fit in single SMS segments.
              </span>
            </div>
          ) : (
            <div className="flex-1 flex flex-col">
              <label className="text-xs text-slate-500 font-bold block mb-1">HTML Email Template Body</label>
              <textarea
                value={emailTemplate}
                onChange={(e) => setEmailTemplate(e.target.value)}
                className="w-full flex-1 min-h-[140px] bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs text-slate-700 font-mono focus:outline-none focus:ring-1 focus:ring-teal-500 resize-none leading-relaxed"
              />
            </div>
          )}

          {/* Placeholders Guide */}
          <div className="bg-slate-50/50 p-3.5 rounded-xl border border-slate-100 flex flex-col gap-1.5">
            <span className="text-[10px] font-mono uppercase font-bold text-slate-400 tracking-wider">
              Dynamic Placeholders Available
            </span>
            <div className="flex flex-wrap gap-2 text-[10px] font-mono text-slate-600">
              <span className="bg-white border px-1.5 py-0.5 rounded">{"{PatientName}"}</span>
              <span className="bg-white border px-1.5 py-0.5 rounded">{"{StaffName}"}</span>
              <span className="bg-white border px-1.5 py-0.5 rounded">{"{ServiceName}"}</span>
              <span className="bg-white border px-1.5 py-0.5 rounded">{"{Date}"}</span>
              <span className="bg-white border px-1.5 py-0.5 rounded">{"{Time}"}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Roster Queue & Dispatch Simulator (5 Columns) */}
      <div className="lg:col-span-5 bg-white p-6 rounded-xl border border-slate-200 flex flex-col h-[460px]" id="reminders-queue-card">
        <div>
          <h3 className="text-base font-bold text-slate-800">Dispatch Queue</h3>
          <p className="text-[10px] text-slate-400">Simulate instant manual notifications dispatch</p>
        </div>

        {/* Queue listings */}
        <div className="flex-1 overflow-y-auto space-y-3 mt-4 pr-1">
          {pendingReminders.map((app) => {
            const patient = patients.find((p) => p.id === app.patientId);
            return (
              <div
                key={app.id}
                className="p-3 border border-slate-100 rounded-xl flex items-center justify-between gap-3 text-xs"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 mb-1">
                    <strong className="text-slate-800 truncate block">
                      {patient?.name}
                    </strong>
                    {app.reminderSent ? (
                      <span className="text-[9px] font-mono bg-emerald-50 text-emerald-600 border border-emerald-100 px-1 rounded-md">
                        Sent
                      </span>
                    ) : (
                      <span className="text-[9px] font-mono bg-amber-50 text-amber-600 border border-amber-100 px-1 rounded-md">
                        Unsent
                      </span>
                    )}
                  </div>
                  <p className="text-[10px] text-slate-500 font-medium truncate">{app.service}</p>
                  <p className="text-[9px] text-slate-400 font-mono mt-1">
                    {app.date} • {app.time}
                  </p>
                </div>

                <button
                  onClick={() => handleSimulateDispatch(app)}
                  className={`flex items-center gap-1 px-3 py-1.5 text-white text-[11px] font-bold rounded-lg shadow-sm transition shrink-0 ${
                    isClinic
                      ? 'bg-teal-600 hover:bg-teal-700'
                      : 'bg-pink-600 hover:bg-pink-700'
                  }`}
                  id={`reminder-dispatch-btn-${app.id}`}
                >
                  <Play className="h-3 w-3 fill-current" /> Dispatch
                </button>
              </div>
            );
          })}

          {pendingReminders.length === 0 && (
            <p className="text-center text-slate-400 py-12 text-xs">No upcoming scheduled appointments.</p>
          )}
        </div>

        {/* Recent logs */}
        <div className="border-t border-slate-100 pt-3 mt-3">
          <span className="text-[9px] font-mono font-bold text-slate-400 uppercase tracking-wide block mb-1">
            Dispatch Log
          </span>
          <div className="bg-slate-50 border border-slate-100 p-2.5 rounded-lg h-[90px] overflow-y-auto space-y-1.5 text-[9px] font-mono text-slate-500">
            {dispatchLogs.map((log) => (
              <div key={log.id} className="flex justify-between gap-2 border-b border-slate-100/50 pb-1">
                <span className="text-slate-600 font-sans truncate">{log.msg}</span>
                <span className="text-slate-400 shrink-0">{log.time}</span>
              </div>
            ))}
            {dispatchLogs.length === 0 && (
              <span className="text-slate-400 block text-center py-6">Logs will render upon dispatch events.</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
