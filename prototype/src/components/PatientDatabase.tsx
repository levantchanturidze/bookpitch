import React, { useState, useMemo } from 'react';
import { Search, UserPlus, Phone, Mail, Calendar, Info, Heart, ShieldAlert, Plus, RefreshCw } from 'lucide-react';
import { Patient, Appointment, WorkspaceMode } from '../types';
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
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6" id="patient-database-root">
      {/* Search and List (5 Columns) */}
      <div className="lg:col-span-5 bg-white p-5 rounded-xl border border-slate-200 flex flex-col h-[580px]" id="patient-list-pane">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-base font-bold text-slate-800">
              {labelPlural} Database
            </h3>
            <p className="text-[10px] text-slate-400">Total: {filteredPatients.length} registered</p>
          </div>

          <button
            onClick={() => setIsAddOpen(true)}
            className={`p-2 text-white rounded-xl flex items-center gap-1.5 text-xs font-semibold shadow-sm transition ${
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
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <input
            type="text"
            placeholder={`Search ${labelPlural.toLowerCase()}...`}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-9 pr-4 py-2 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-teal-500"
          />
        </div>

        {/* Patients Scroller */}
        <div className="flex-1 overflow-y-auto space-y-2 pr-1">
          {filteredPatients.map((p) => {
            const isSelected = p.id === activePatient?.id;
            return (
              <div
                key={p.id}
                onClick={() => setSelectedId(p.id)}
                className={`p-3 rounded-xl border transition cursor-pointer flex items-center gap-3 ${
                  isSelected
                    ? isClinic
                      ? 'bg-teal-50/70 border-teal-200 text-teal-900 shadow-sm'
                      : 'bg-pink-50/70 border-pink-200 text-pink-900 shadow-sm'
                    : 'bg-white border-slate-100 hover:border-slate-200'
                }`}
                id={`patient-card-${p.id}`}
              >
                <img
                  src={p.avatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150'}
                  alt={p.name}
                  className="w-10 h-10 rounded-full object-cover bg-slate-50 border"
                  referrerPolicy="no-referrer"
                />
                <div className="flex-1 min-w-0">
                  <span className="text-xs font-bold block truncate">
                    {p.name}
                  </span>
                  <span className="text-[10px] text-slate-400 block font-mono">
                    {p.phone}
                  </span>
                </div>
                {p.allergies && p.allergies !== 'None' && (
                  <span className="w-2 h-2 rounded-full bg-rose-500 shrink-0" title="Allergies / Notices present"></span>
                )}
              </div>
            );
          })}

          {filteredPatients.length === 0 && (
            <div className="text-center py-12 text-slate-400 flex flex-col items-center">
              <Search className="h-8 w-8 text-slate-300 stroke-1 mb-2" />
              <p className="text-xs">No records found matching search terms.</p>
            </div>
          )}
        </div>
      </div>

      {/* Detailed Patient File (7 Columns) */}
      <div className="lg:col-span-7 bg-white p-6 rounded-xl border border-slate-200 h-[580px] flex flex-col" id="patient-details-pane">
        {activePatient ? (
          <div className="flex-1 flex flex-col overflow-y-auto pr-1">
            {/* Top overview card */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-5 border-b border-slate-100 gap-4">
              <div className="flex items-center gap-4">
                <img
                  src={activePatient.avatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150'}
                  alt={activePatient.name}
                  className="w-16 h-16 rounded-2xl object-cover bg-slate-50 border"
                  referrerPolicy="no-referrer"
                />
                <div>
                  <h3 className="text-lg font-bold text-slate-800">{activePatient.name}</h3>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-[10px] bg-slate-100 px-2 py-0.5 text-slate-600 rounded">
                      ID: {activePatient.id}
                    </span>
                    <span className="text-[10px] font-mono text-slate-400">
                      Joined {activePatient.joinedDate}
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex flex-col text-right sm:text-right text-[11px] font-mono text-slate-500 gap-1 bg-slate-50 p-2.5 rounded-xl border border-slate-100">
                <span className="flex items-center justify-end gap-1">
                  <Calendar className="h-3.5 w-3.5 text-slate-400" /> DOB: {activePatient.dob}
                </span>
                <span>Gender: {activePatient.gender}</span>
              </div>
            </div>

            {/* Content Tabs Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-5">
              {/* Left col: Contact info & alerts */}
              <div className="space-y-4">
                <div className="border border-slate-100 p-4 rounded-xl">
                  <span className="text-[10px] font-mono uppercase font-bold text-slate-400 tracking-wider block mb-2">
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
                <div className={`p-4 rounded-xl border ${activePatient.allergies && activePatient.allergies !== 'None' ? 'bg-rose-50/50 border-rose-100' : 'bg-slate-50/50 border-slate-100'}`}>
                  <span className="text-[10px] font-mono uppercase font-bold text-slate-400 tracking-wider block mb-2 flex items-center gap-1">
                    <ShieldAlert className={`h-3.5 w-3.5 ${activePatient.allergies && activePatient.allergies !== 'None' ? 'text-rose-500' : 'text-slate-400'}`} />
                    {isClinic ? 'Contraindications & Allergies' : 'Sensitivities / Warnings'}
                  </span>
                  <p className={`text-xs font-semibold ${activePatient.allergies && activePatient.allergies !== 'None' ? 'text-rose-800' : 'text-slate-600'}`}>
                    {activePatient.allergies || 'No allergies listed'}
                  </p>
                </div>

                {/* Clinical / Beauty specific notes */}
                <div className="border border-slate-100 p-4 rounded-xl">
                  <span className="text-[10px] font-mono uppercase font-bold text-slate-400 tracking-wider block mb-1">
                    {isClinic ? 'Clinical Intake Notes' : 'Stylist Session Notes'}
                  </span>
                  <p className="text-xs text-slate-600 leading-relaxed font-sans">
                    {activePatient.notes || 'No custom notes set for this profile yet.'}
                  </p>
                </div>
              </div>

              {/* Right col: Treatment history & appointment summary */}
              <div className="space-y-4">
                {/* Historical records */}
                <div className="border border-slate-100 p-4 rounded-xl h-[180px] flex flex-col">
                  <span className="text-[10px] font-mono uppercase font-bold text-slate-400 tracking-wider block mb-2">
                    Treatment History
                  </span>
                  <div className="flex-1 overflow-y-auto space-y-1.5 pr-1">
                    {activePatient.history && activePatient.history.length > 0 ? (
                      activePatient.history.map((record, i) => (
                        <div key={i} className="text-xs text-slate-700 bg-slate-50 p-2 rounded-lg border border-slate-100">
                          {record}
                        </div>
                      ))
                    ) : (
                      <p className="text-[11px] text-slate-400 italic">No historical visits logged yet.</p>
                    )}
                  </div>
                </div>

                {/* Direct scheduling summary */}
                <div className="border border-slate-100 p-4 rounded-xl flex-1 flex flex-col">
                  <span className="text-[10px] font-mono uppercase font-bold text-slate-400 tracking-wider block mb-2">
                    Visits & Status
                  </span>
                  <div className="flex-1 overflow-y-auto space-y-2 pr-1 max-h-[140px]">
                    {patientBookings.map((bk) => (
                      <div key={bk.id} className="flex justify-between items-center text-xs p-2 bg-slate-50 border border-slate-100 rounded-lg">
                        <div>
                          <strong className="text-slate-800 block text-[11px]">{bk.service}</strong>
                          <span className="text-[10px] text-slate-400 font-mono">{bk.date} at {bk.time}</span>
                        </div>
                        <span className={`text-[9px] px-1.5 py-0.5 rounded-full border font-mono ${
                          bk.status === 'confirmed' ? 'bg-emerald-100 border-emerald-200 text-emerald-800' :
                          bk.status === 'completed' ? 'bg-blue-100 border-blue-200 text-blue-800' : 'bg-slate-100 border-slate-200 text-slate-600'
                        }`}>
                          {bk.status}
                        </span>
                      </div>
                    ))}
                    {patientBookings.length === 0 && (
                      <p className="text-[11px] text-slate-400 italic">No scheduled upcoming sessions.</p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-slate-400">
            <Info className="h-10 w-10 stroke-1 mb-2 text-slate-300" />
            <p className="text-xs">Select a {labelSingular.toLowerCase()} to inspect details.</p>
          </div>
        )}
      </div>

      {/* ADD PATIENT / CLIENT DRAWER MODAL */}
      <AnimatePresence>
        {isAddOpen && (
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white rounded-xl w-full max-w-md p-6 border border-slate-200 shadow-lg"
            >
              <h3 className="text-base font-bold text-slate-800 mb-4 flex items-center gap-1.5">
                <UserPlus className="h-5 w-5 text-teal-600" /> Create {labelSingular} Profile
              </h3>

              <form onSubmit={handleSubmit} className="space-y-4">
                {/* Name */}
                <div>
                  <label className="text-xs text-slate-500 font-bold block mb-1">Full Name *</label>
                  <input
                    type="text"
                    required
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    placeholder="Sarah Connor"
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 text-xs text-slate-700"
                  />
                </div>

                {/* Phone & Email */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-slate-500 font-bold block mb-1">Phone *</label>
                    <input
                      type="tel"
                      required
                      value={formPhone}
                      onChange={(e) => setFormPhone(e.target.value)}
                      placeholder="+1 (555) 000-0000"
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 text-xs text-slate-700"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 font-bold block mb-1">Email</label>
                    <input
                      type="email"
                      value={formEmail}
                      onChange={(e) => setFormEmail(e.target.value)}
                      placeholder="email@example.com"
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 text-xs text-slate-700"
                    />
                  </div>
                </div>

                {/* DOB & Gender */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-slate-500 font-bold block mb-1">Date of Birth</label>
                    <input
                      type="date"
                      value={formDob}
                      onChange={(e) => setFormDob(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 text-xs text-slate-700"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 font-bold block mb-1">Gender</label>
                    <select
                      value={formGender}
                      onChange={(e) => setFormGender(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 text-xs text-slate-700"
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
                  <label className="text-xs text-slate-500 font-bold block mb-1">
                    {isClinic ? 'Contraindications & Allergies' : 'Skin Concerns & Sensitivities'}
                  </label>
                  <input
                    type="text"
                    value={formSensitivities}
                    onChange={(e) => setFormSensitivities(e.target.value)}
                    placeholder={isClinic ? 'e.g. Penicillin, Latex allergy' : 'e.g. Retinol user, peanut oils'}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 text-xs text-slate-700"
                  />
                </div>

                {/* Intake Notes */}
                <div>
                  <label className="text-xs text-slate-500 font-bold block mb-1">Intake / Stylist Notes</label>
                  <textarea
                    value={formNotes}
                    onChange={(e) => setFormNotes(e.target.value)}
                    placeholder="Add general context or special scheduling rules..."
                    rows={2.5}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 text-xs text-slate-700 resize-none"
                  />
                </div>

                {/* Form Actions */}
                <div className="flex items-center justify-end gap-2 pt-3">
                  <button
                    type="button"
                    onClick={() => setIsAddOpen(false)}
                    className="px-4 py-2 border border-slate-200 text-slate-500 hover:bg-slate-50 rounded-xl text-xs font-semibold"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className={`px-4 py-2 text-white rounded-xl text-xs font-semibold transition ${
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
