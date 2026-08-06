import React, { useState, useMemo } from 'react';
import {
  Search,
  UserPlus,
  Phone,
  Mail,
  Calendar,
  Info,
  Heart,
  ShieldAlert,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { Patient, Appointment, WorkspaceMode } from '@/lib/types';
import { motion, AnimatePresence } from 'motion/react';

interface PatientDatabaseProps {
  mode: WorkspaceMode;
  patients: Patient[];
  appointments: Appointment[];
  onAddPatient: (patient: Omit<Patient, 'id' | 'joinedDate' | 'avatar'>) => void;
  selectedPatientId?: string;
}

export default function PatientDatabase({
  mode,
  patients,
  appointments,
  onAddPatient,
  selectedPatientId,
}: PatientDatabaseProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedId, setSelectedId] = useState<string>(selectedPatientId || patients[0]?.id || '');
  const [isAddOpen, setIsAddOpen] = useState(false);

  // New Patient Form state
  const [formName, setFormName] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formPhone, setFormPhone] = useState('');
  const [formDob, setFormDob] = useState('1990-01-01');
  const [formGender, setFormGender] = useState('Female');
  const [formNotes, setFormNotes] = useState('');
  const [formSensitivities, setFormSensitivities] = useState('');

  // Mode helpers
  const isClinic = mode === 'clinic';
  const labelPlural = isClinic ? 'Patients' : 'Clients';
  const labelSingular = isClinic ? 'Patient' : 'Client';

  // Selected Patient object
  const activePatient = useMemo(() => {
    return patients.find((p) => p.id === selectedId) || patients[0];
  }, [patients, selectedId]);

  // List of bookings for the active patient
  const patientBookings = useMemo(() => {
    if (!activePatient) return [];
    return appointments.filter((app) => app.patientId === activePatient.id);
  }, [appointments, activePatient]);

  // Filtered patients list
  const filteredPatients = useMemo(() => {
    return patients.filter((p) => {
      const target = `${p.name} ${p.phone} ${p.email}`.toLowerCase();
      return target.includes(searchTerm.toLowerCase());
    });
  }, [patients, searchTerm]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName || !formPhone) {
      alert('Name and Phone are required.');
      return;
    }

    onAddPatient({
      name: formName,
      email: formEmail || 'no-email@example.com',
      phone: formPhone,
      dob: formDob,
      gender: formGender,
      notes: formNotes,
      allergies: formSensitivities,
      history: [],
    });

    // Reset Form
    setFormName('');
    setFormEmail('');
    setFormPhone('');
    setFormNotes('');
    setFormSensitivities('');
    setIsAddOpen(false);
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12" id="patient-database-root">
      {/* Search and List (5 Columns) */}
      <div
        className="flex h-[580px] flex-col rounded-xl border border-slate-200 bg-white p-5 lg:col-span-5"
        id="patient-list-pane"
      >
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-base font-bold text-slate-800">{labelPlural} Database</h3>
            <p className="text-[10px] text-slate-400">
              Total: {filteredPatients.length} registered
            </p>
          </div>

          <button
            onClick={() => setIsAddOpen(true)}
            className={`flex items-center gap-1.5 rounded-xl p-2 text-xs font-semibold text-white shadow-sm transition ${
              isClinic ? 'bg-teal-600 hover:bg-teal-700' : 'bg-pink-600 hover:bg-pink-700'
            }`}
            id="add-patient-trigger"
          >
            <UserPlus className="h-4 w-4" />
            <span className="hidden sm:inline">Add {labelSingular}</span>
          </button>
        </div>

        {/* Search Input */}
        <div className="relative mb-4">
          <Search className="absolute top-2.5 left-3 h-4 w-4 text-slate-400" />
          <input
            type="text"
            placeholder={`Search ${labelPlural.toLowerCase()}...`}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2 pr-4 pl-9 text-xs text-slate-700 focus:ring-1 focus:ring-teal-500 focus:outline-none"
          />
        </div>

        {/* Patients Scroller */}
        <div className="flex-1 space-y-2 overflow-y-auto pr-1">
          {filteredPatients.map((p) => {
            const isSelected = p.id === activePatient?.id;
            return (
              <div
                key={p.id}
                onClick={() => setSelectedId(p.id)}
                className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition ${
                  isSelected
                    ? isClinic
                      ? 'border-teal-200 bg-teal-50/70 text-teal-900 shadow-sm'
                      : 'border-pink-200 bg-pink-50/70 text-pink-900 shadow-sm'
                    : 'border-slate-100 bg-white hover:border-slate-200'
                }`}
                id={`patient-card-${p.id}`}
              >
                <img
                  src={
                    p.avatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150'
                  }
                  alt={p.name}
                  className="h-10 w-10 rounded-full border bg-slate-50 object-cover"
                  referrerPolicy="no-referrer"
                />
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-bold">{p.name}</span>
                  <span className="block font-mono text-[10px] text-slate-400">{p.phone}</span>
                </div>
                {p.allergies && p.allergies !== 'None' && (
                  <span
                    className="h-2 w-2 shrink-0 rounded-full bg-rose-500"
                    title="Allergies / Notices present"
                  ></span>
                )}
              </div>
            );
          })}

          {filteredPatients.length === 0 && (
            <div className="flex flex-col items-center py-12 text-center text-slate-400">
              <Search className="mb-2 h-8 w-8 stroke-1 text-slate-300" />
              <p className="text-xs">No records found matching search terms.</p>
            </div>
          )}
        </div>
      </div>

      {/* Detailed Patient File (7 Columns) */}
      <div
        className="flex h-[580px] flex-col rounded-xl border border-slate-200 bg-white p-6 lg:col-span-7"
        id="patient-details-pane"
      >
        {activePatient ? (
          <div className="flex flex-1 flex-col overflow-y-auto pr-1">
            {/* Top overview card */}
            <div className="flex flex-col justify-between gap-4 border-b border-slate-100 pb-5 sm:flex-row sm:items-center">
              <div className="flex items-center gap-4">
                <img
                  src={
                    activePatient.avatar ||
                    'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150'
                  }
                  alt={activePatient.name}
                  className="h-16 w-16 rounded-2xl border bg-slate-50 object-cover"
                  referrerPolicy="no-referrer"
                />
                <div>
                  <h3 className="text-lg font-bold text-slate-800">{activePatient.name}</h3>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="rounded bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">
                      ID: {activePatient.id}
                    </span>
                    <span className="font-mono text-[10px] text-slate-400">
                      Joined {activePatient.joinedDate}
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-1 rounded-xl border border-slate-100 bg-slate-50 p-2.5 text-right font-mono text-[11px] text-slate-500 sm:text-right">
                <span className="flex items-center justify-end gap-1">
                  <Calendar className="h-3.5 w-3.5 text-slate-400" /> DOB: {activePatient.dob}
                </span>
                <span>Gender: {activePatient.gender}</span>
              </div>
            </div>

            {/* Content Tabs Grid */}
            <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
              {/* Left col: Contact info & alerts */}
              <div className="space-y-4">
                <div className="rounded-xl border border-slate-100 p-4">
                  <span className="mb-2 block font-mono text-[10px] font-bold tracking-wider text-slate-400 uppercase">
                    Contact Details
                  </span>
                  <div className="space-y-2 text-xs">
                    <div className="flex items-center gap-2 text-slate-600">
                      <Phone className="h-3.5 w-3.5 text-slate-400" /> {activePatient.phone}
                    </div>
                    <div className="flex items-center gap-2 text-slate-600">
                      <Mail className="h-3.5 w-3.5 text-slate-400" /> {activePatient.email}
                    </div>
                  </div>
                </div>

                {/* Medical safety or Sensitivities block */}
                <div
                  className={`rounded-xl border p-4 ${activePatient.allergies && activePatient.allergies !== 'None' ? 'border-rose-100 bg-rose-50/50' : 'border-slate-100 bg-slate-50/50'}`}
                >
                  <span className="mb-2 block flex items-center gap-1 font-mono text-[10px] font-bold tracking-wider text-slate-400 uppercase">
                    <ShieldAlert
                      className={`h-3.5 w-3.5 ${activePatient.allergies && activePatient.allergies !== 'None' ? 'text-rose-500' : 'text-slate-400'}`}
                    />
                    {isClinic ? 'Contraindications & Allergies' : 'Sensitivities / Warnings'}
                  </span>
                  <p
                    className={`text-xs font-semibold ${activePatient.allergies && activePatient.allergies !== 'None' ? 'text-rose-800' : 'text-slate-600'}`}
                  >
                    {activePatient.allergies || 'No allergies listed'}
                  </p>
                </div>

                {/* Clinical / Beauty specific notes */}
                <div className="rounded-xl border border-slate-100 p-4">
                  <span className="mb-1 block font-mono text-[10px] font-bold tracking-wider text-slate-400 uppercase">
                    {isClinic ? 'Clinical Intake Notes' : 'Stylist Session Notes'}
                  </span>
                  <p className="font-sans text-xs leading-relaxed text-slate-600">
                    {activePatient.notes || 'No custom notes set for this profile yet.'}
                  </p>
                </div>
              </div>

              {/* Right col: Treatment history & appointment summary */}
              <div className="space-y-4">
                {/* Historical records */}
                <div className="flex h-[180px] flex-col rounded-xl border border-slate-100 p-4">
                  <span className="mb-2 block font-mono text-[10px] font-bold tracking-wider text-slate-400 uppercase">
                    Treatment History
                  </span>
                  <div className="flex-1 space-y-1.5 overflow-y-auto pr-1">
                    {activePatient.history && activePatient.history.length > 0 ? (
                      activePatient.history.map((record, i) => (
                        <div
                          key={i}
                          className="rounded-lg border border-slate-100 bg-slate-50 p-2 text-xs text-slate-700"
                        >
                          {record}
                        </div>
                      ))
                    ) : (
                      <p className="text-[11px] text-slate-400 italic">
                        No historical visits logged yet.
                      </p>
                    )}
                  </div>
                </div>

                {/* Direct scheduling summary */}
                <div className="flex flex-1 flex-col rounded-xl border border-slate-100 p-4">
                  <span className="mb-2 block font-mono text-[10px] font-bold tracking-wider text-slate-400 uppercase">
                    Visits & Status
                  </span>
                  <div className="max-h-[140px] flex-1 space-y-2 overflow-y-auto pr-1">
                    {patientBookings.map((bk) => (
                      <div
                        key={bk.id}
                        className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50 p-2 text-xs"
                      >
                        <div>
                          <strong className="block text-[11px] text-slate-800">{bk.service}</strong>
                          <span className="font-mono text-[10px] text-slate-400">
                            {bk.date} at {bk.time}
                          </span>
                        </div>
                        <span
                          className={`rounded-full border px-1.5 py-0.5 font-mono text-[9px] ${
                            bk.status === 'confirmed'
                              ? 'border-emerald-200 bg-emerald-100 text-emerald-800'
                              : bk.status === 'completed'
                                ? 'border-blue-200 bg-blue-100 text-blue-800'
                                : 'border-slate-200 bg-slate-100 text-slate-600'
                          }`}
                        >
                          {bk.status}
                        </span>
                      </div>
                    ))}
                    {patientBookings.length === 0 && (
                      <p className="text-[11px] text-slate-400 italic">
                        No scheduled upcoming sessions.
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center text-slate-400">
            <Info className="mb-2 h-10 w-10 stroke-1 text-slate-300" />
            <p className="text-xs">Select a {labelSingular.toLowerCase()} to inspect details.</p>
          </div>
        )}
      </div>

      {/* ADD PATIENT / CLIENT DRAWER MODAL */}
      <AnimatePresence>
        {isAddOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-lg"
            >
              <h3 className="mb-4 flex items-center gap-1.5 text-base font-bold text-slate-800">
                <UserPlus className="h-5 w-5 text-teal-600" /> Create {labelSingular} Profile
              </h3>

              <form onSubmit={handleSubmit} className="space-y-4">
                {/* Name */}
                <div>
                  <label className="mb-1 block text-xs font-bold text-slate-500">Full Name *</label>
                  <input
                    type="text"
                    required
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    placeholder="Sarah Connor"
                    className="w-full rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700"
                  />
                </div>

                {/* Phone & Email */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-xs font-bold text-slate-500">Phone *</label>
                    <input
                      type="tel"
                      required
                      value={formPhone}
                      onChange={(e) => setFormPhone(e.target.value)}
                      placeholder="+1 (555) 000-0000"
                      className="w-full rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-bold text-slate-500">Email</label>
                    <input
                      type="email"
                      value={formEmail}
                      onChange={(e) => setFormEmail(e.target.value)}
                      placeholder="email@example.com"
                      className="w-full rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700"
                    />
                  </div>
                </div>

                {/* DOB & Gender */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-xs font-bold text-slate-500">
                      Date of Birth
                    </label>
                    <input
                      type="date"
                      value={formDob}
                      onChange={(e) => setFormDob(e.target.value)}
                      className="w-full rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-bold text-slate-500">Gender</label>
                    <select
                      value={formGender}
                      onChange={(e) => setFormGender(e.target.value)}
                      className="w-full rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700"
                    >
                      <option value="Female">Female</option>
                      <option value="Male">Male</option>
                      <option value="Non-binary">Non-binary</option>
                      <option value="Prefer not to say">Other</option>
                    </select>
                  </div>
                </div>

                {/* Sensitivities/Allergies */}
                <div>
                  <label className="mb-1 block text-xs font-bold text-slate-500">
                    {isClinic ? 'Contraindications & Allergies' : 'Skin Concerns & Sensitivities'}
                  </label>
                  <input
                    type="text"
                    value={formSensitivities}
                    onChange={(e) => setFormSensitivities(e.target.value)}
                    placeholder={
                      isClinic ? 'e.g. Penicillin, Latex allergy' : 'e.g. Retinol user, peanut oils'
                    }
                    className="w-full rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700"
                  />
                </div>

                {/* Intake Notes */}
                <div>
                  <label className="mb-1 block text-xs font-bold text-slate-500">
                    Intake / Stylist Notes
                  </label>
                  <textarea
                    value={formNotes}
                    onChange={(e) => setFormNotes(e.target.value)}
                    placeholder="Add general context or special scheduling rules..."
                    rows={2.5}
                    className="w-full resize-none rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700"
                  />
                </div>

                {/* Form Actions */}
                <div className="flex items-center justify-end gap-2 pt-3">
                  <button
                    type="button"
                    onClick={() => setIsAddOpen(false)}
                    className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-500 hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className={`rounded-xl px-4 py-2 text-xs font-semibold text-white transition ${
                      isClinic ? 'bg-teal-600 hover:bg-teal-700' : 'bg-pink-600 hover:bg-pink-700'
                    }`}
                  >
                    Create Profile
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
