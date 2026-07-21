import React, { useState, useMemo } from 'react';
import { Calendar as CalendarIcon, Clock, User, CheckCircle2, AlertCircle, Plus, ChevronLeft, ChevronRight, Filter, DollarSign, FileText, Phone, Sparkles, Stethoscope } from 'lucide-react';
import { Appointment, Patient, Staff, WorkspaceMode } from '../types';
import { motion, AnimatePresence } from 'motion/react';

interface CalendarViewProps {
  mode: WorkspaceMode;
  appointments: Appointment[];
  patients: Patient[];
  staff: Staff[];
  onAddAppointment: (appointment: Omit<Appointment, 'id'>) => void;
  onUpdateAppointmentStatus: (id: string, status: Appointment['status']) => void;
  onUpdatePaymentStatus: (id: string, status: Appointment['paymentStatus']) => void;
  onSelectPatient: (patientId: string) => void;
}

export default function CalendarView({
  mode,
  appointments,
  patients,
  staff,
  onAddAppointment,
  onUpdateAppointmentStatus,
  onUpdatePaymentStatus,
  onSelectPatient,
}: CalendarViewProps) {
  const [currentDate, setCurrentDate] = useState<Date>(new Date(2026, 6, 21)); // July 21, 2026
  const [selectedDateStr, setSelectedDateStr] = useState<string>('2026-07-21');
  const [filterStaff, setFilterStaff] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [isBookModalOpen, setIsBookModalOpen] = useState(false);
  const [selectedAppointment, setSelectedAppointment] = useState<Appointment | null>(null);

  // New Appointment Form State
  const [formPatientId, setFormPatientId] = useState('');
  const [formStaffId, setFormStaffId] = useState('');
  const [formTime, setFormTime] = useState('10:00');
  const [formDuration, setFormDuration] = useState(30);
  const [formService, setFormService] = useState('');
  const [formPrice, setFormPrice] = useState(100);
  const [formNotes, setFormNotes] = useState('');

  // Mode helpers
  const isClinic = mode === 'clinic';
  const staffLabel = isClinic ? 'Doctor' : 'Stylist';
  const patientLabel = isClinic ? 'Patient' : 'Client';
  const serviceLabel = isClinic ? 'Treatment' : 'Service';

  // Services options based on mode
  const servicesList = isClinic
    ? [
        { name: 'General Consultation', price: 120, duration: 30 },
        { name: 'Cardiology Assessment', price: 280, duration: 45 },
        { name: 'Dermatological Exam', price: 150, duration: 30 },
        { name: 'Pediatric Checkup', price: 110, duration: 30 },
        { name: 'Dental Cleaning & Fill', price: 180, duration: 60 },
        { name: 'Physiotherapy Session', price: 95, duration: 45 },
      ]
    : [
        { name: 'Luxury Balayage & Cut', price: 240, duration: 120 },
        { name: 'Signature Hydrafacial', price: 160, duration: 60 },
        { name: 'Gel Manicure & Pedicure', price: 90, duration: 75 },
        { name: 'Swedish Full Body Massage', price: 130, duration: 60 },
        { name: 'Eyelash Extensions (Full)', price: 150, duration: 90 },
        { name: 'Beard Trim & Hot Towel Shave', price: 65, duration: 45 },
      ];

  // Month navigation
  const prevMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1));
  };

  const nextMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1));
  };

  // Generate calendar days
  const daysInMonth = useMemo(() => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);

    const startOffset = firstDay.getDay(); // Sunday-based
    const totalDays = lastDay.getDate();

    const days: (Date | null)[] = [];
    for (let i = 0; i < startOffset; i++) {
      days.push(null);
    }
    for (let i = 1; i <= totalDays; i++) {
      days.push(new Date(year, month, i));
    }
    return days;
  }, [currentDate]);

  // Handle service change in booking form to prefill price and duration
  const handleServiceChange = (serviceName: string) => {
    setFormService(serviceName);
    const found = servicesList.find((s) => s.name === serviceName);
    if (found) {
      setFormPrice(found.price);
      setFormDuration(found.duration);
    }
  };

  // Filtered Appointments
  const filteredAppointments = useMemo(() => {
    return appointments.filter((app) => {
      const matchDate = app.date === selectedDateStr;
      const matchStaff = filterStaff === 'all' || app.staffId === filterStaff;
      const matchStatus = filterStatus === 'all' || app.status === filterStatus;
      return matchDate && matchStaff && matchStatus;
    });
  }, [appointments, selectedDateStr, filterStaff, filterStatus]);

  // Handle Book Form Submit
  const handleBookSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formPatientId || !formStaffId || !formService) {
      alert('Please fill out all mandatory fields.');
      return;
    }

    onAddAppointment({
      patientId: formPatientId,
      staffId: formStaffId,
      date: selectedDateStr,
      time: formTime,
      duration: Number(formDuration),
      service: formService,
      price: Number(formPrice),
      status: 'confirmed',
      paymentStatus: 'unpaid',
      reminderSent: false,
      notes: formNotes,
    });

    // Reset Form
    setFormPatientId('');
    setFormStaffId('');
    setFormService('');
    setFormNotes('');
    setIsBookModalOpen(false);
  };

  // Status badges mapping
  const statusBadges = {
    pending: 'bg-amber-100 text-amber-800 border-amber-200',
    confirmed: 'bg-emerald-100 text-emerald-800 border-emerald-200',
    completed: 'bg-blue-100 text-blue-800 border-blue-200',
    cancelled: 'bg-rose-100 text-rose-800 border-rose-200',
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6" id="calendar-view-container">
      {/* Calendar Controller & Picker (7 Columns) */}
      <div className="lg:col-span-7 bg-white p-6 rounded-xl border border-slate-200" id="calendar-left-pane">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${isClinic ? 'bg-teal-50 text-teal-600' : 'bg-pink-50 text-pink-600'}`}>
              {isClinic ? <Stethoscope className="h-5 w-5" /> : <Sparkles className="h-5 w-5" />}
            </div>
            <div>
              <h2 className="text-xl font-bold text-slate-800 font-sans">
                {isClinic ? 'Medical Appointments' : 'Salon Appointments'}
              </h2>
              <p className="text-xs text-slate-400">Manage {isClinic ? 'patient visits' : 'styling sessions'}</p>
            </div>
          </div>

          <div className="flex items-center gap-1 border border-slate-100 rounded-lg p-1 bg-slate-50">
            <button
              onClick={prevMonth}
              className="p-1.5 hover:bg-white rounded-md transition text-slate-600"
              title="Previous Month"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="px-3 py-1 font-semibold text-xs text-slate-700 min-w-[100px] text-center">
              {currentDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
            </span>
            <button
              onClick={nextMonth}
              className="p-1.5 hover:bg-white rounded-md transition text-slate-600"
              title="Next Month"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Calendar Grid */}
        <div className="grid grid-cols-7 gap-1 text-center mb-2 font-mono text-[10px] font-bold text-slate-400 tracking-wider">
          <div>SUN</div>
          <div>MON</div>
          <div>TUE</div>
          <div>WED</div>
          <div>THU</div>
          <div>FRI</div>
          <div>SAT</div>
        </div>

        <div className="grid grid-cols-7 gap-2">
          {daysInMonth.map((day, idx) => {
            if (!day) return <div key={`empty-${idx}`} className="aspect-square bg-slate-50/50 rounded-lg"></div>;

            const dStr = day.toISOString().split('T')[0];
            const isSelected = dStr === selectedDateStr;
            const isToday = dStr === '2026-07-21';

            // Count bookings for this day
            const bookingsCount = appointments.filter((a) => a.date === dStr && a.status !== 'cancelled').length;

            return (
              <button
                key={dStr}
                onClick={() => setSelectedDateStr(dStr)}
                className={`relative aspect-square p-2 rounded-xl flex flex-col justify-between transition group border ${
                  isSelected
                    ? isClinic
                      ? 'bg-teal-600 text-white border-teal-600 shadow-md shadow-teal-100'
                      : 'bg-pink-600 text-white border-pink-600 shadow-md shadow-pink-100'
                    : isToday
                      ? 'bg-slate-50 text-slate-800 border-slate-300 font-bold'
                      : 'bg-white text-slate-700 border-slate-100 hover:border-slate-300 hover:bg-slate-50'
                }`}
                id={`calendar-day-btn-${dStr}`}
              >
                <span className="text-xs font-semibold">{day.getDate()}</span>
                {bookingsCount > 0 && (
                  <div className="w-full flex justify-end">
                    <span
                      className={`text-[9px] px-1.5 py-0.5 rounded-full font-mono font-bold leading-none ${
                        isSelected
                          ? 'bg-white text-slate-900'
                          : isClinic
                            ? 'bg-teal-50 text-teal-700'
                            : 'bg-pink-50 text-pink-700'
                      }`}
                    >
                      {bookingsCount}
                    </span>
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {/* Quick legend */}
        <div className="mt-5 pt-4 border-t border-slate-100 flex flex-wrap justify-between items-center text-xs text-slate-500 gap-2">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-emerald-500"></span> Confirmed
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-amber-500"></span> Pending
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-blue-500"></span> Completed
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-rose-500"></span> Cancelled
            </span>
          </div>

          <button
            onClick={() => setIsBookModalOpen(true)}
            className={`flex items-center gap-1.5 px-4 py-2 text-white font-medium rounded-xl text-xs transition shadow-sm ${
              isClinic
                ? 'bg-teal-600 hover:bg-teal-700 hover:shadow-teal-100'
                : 'bg-pink-600 hover:bg-pink-700 hover:shadow-pink-100'
            }`}
            id="book-appointment-trigger"
          >
            <Plus className="h-4 w-4" />
            Book {isClinic ? 'Patient' : 'Session'}
          </button>
        </div>
      </div>

      {/* Appointment Day List (5 Columns) */}
      <div className="lg:col-span-5 flex flex-col gap-6" id="calendar-right-pane">
        {/* Filters */}
        <div className="bg-white p-4 rounded-xl border border-slate-200 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-400 tracking-wider flex items-center gap-1">
              <Filter className="h-3 w-3" /> LIST FILTERS
            </span>
            <button
              onClick={() => {
                setFilterStaff('all');
                setFilterStatus('all');
              }}
              className="text-[10px] text-slate-400 hover:text-slate-600 underline"
            >
              Reset Filters
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-slate-500 font-bold block mb-1">Filter Staff</label>
              <select
                value={filterStaff}
                onChange={(e) => setFilterStaff(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 text-xs text-slate-700 rounded-lg p-2 focus:ring-1 focus:ring-teal-500"
              >
                <option value="all">All Staff</option>
                {staff
                  .filter((st) => {
                    // Filter staff relevant to current mode if needed,
                    // but we can list all available
                    return isClinic ? st.role.includes('GP') || st.role.includes('Director') || st.role.includes('Physio') || st.role.includes('Cardio') : st.role.includes('Stylist') || st.role.includes('Esthetician') || st.role.includes('Therapist');
                  })
                  .map((st) => (
                    <option key={st.id} value={st.id}>
                      {st.name}
                    </option>
                  ))}
              </select>
            </div>

            <div>
              <label className="text-[10px] text-slate-500 font-bold block mb-1">Status</label>
              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 text-xs text-slate-700 rounded-lg p-2 focus:ring-1 focus:ring-teal-500"
              >
                <option value="all">All Statuses</option>
                <option value="pending">Pending</option>
                <option value="confirmed">Confirmed</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </div>
          </div>
        </div>

        {/* Booking list for the day */}
        <div className="bg-white p-6 rounded-xl border border-slate-200 flex-1 flex flex-col">
          <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-50">
            <div>
              <h3 className="text-sm font-bold text-slate-800">
                Bookings for {new Date(selectedDateStr).toLocaleDateString('en-US', { day: 'numeric', month: 'short', weekday: 'short' })}
              </h3>
              <p className="text-[10px] text-slate-400">Total: {filteredAppointments.length} bookings</p>
            </div>
            <span className="text-xs font-mono bg-slate-100 px-2 py-1 text-slate-600 rounded">
              {selectedDateStr}
            </span>
          </div>

          {/* List Wrapper */}
          <div className="flex-1 overflow-y-auto space-y-3 max-h-[360px] pr-1">
            {filteredAppointments.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center py-12 text-slate-400">
                <CalendarIcon className="h-8 w-8 stroke-1 text-slate-300 mb-2" />
                <p className="text-xs font-medium">No appointments for this date</p>
                <p className="text-[10px] mt-0.5">Click the Book button or select another date.</p>
              </div>
            ) : (
              filteredAppointments.map((app) => {
                const patient = patients.find((p) => p.id === app.patientId);
                const st = staff.find((s) => s.id === app.staffId);

                return (
                  <div
                    key={app.id}
                    onClick={() => setSelectedAppointment(app)}
                    className="p-3 border border-slate-100 hover:border-slate-200 hover:bg-slate-50/50 rounded-xl cursor-pointer transition flex items-start gap-3 relative overflow-hidden"
                  >
                    {/* Color bar indicator */}
                    <div
                      className="absolute left-0 top-0 bottom-0 w-1.5"
                      style={{ backgroundColor: st?.color || '#cbd5e1' }}
                    ></div>

                    {/* Patient Avatar or Icon */}
                    <img
                      src={patient?.avatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150'}
                      alt={patient?.name}
                      className="w-9 h-9 rounded-lg object-cover bg-slate-100 flex-shrink-0"
                      referrerPolicy="no-referrer"
                    />

                    {/* Meta info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="text-xs font-bold text-slate-800 truncate block">
                          {patient?.name || 'Unknown Patient'}
                        </span>
                        <span className="text-[10px] font-mono font-medium text-slate-400 flex items-center gap-1">
                          <Clock className="h-2.5 w-2.5" /> {app.time} ({app.duration}m)
                        </span>
                      </div>

                      <p className="text-[10px] text-slate-500 font-medium truncate">
                        {app.service}
                      </p>

                      <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-100/50">
                        <span className="text-[9px] text-slate-400 font-mono">
                          {staffLabel}: <strong className="text-slate-600 font-sans">{st?.name.split(' ')[1]}</strong>
                        </span>
                        <div className="flex items-center gap-1.5">
                          <span className={`text-[9px] px-1.5 py-0.5 rounded-full border ${statusBadges[app.status]}`}>
                            {app.status}
                          </span>
                          <span
                            className={`text-[9px] font-mono px-1 rounded ${
                              app.paymentStatus === 'paid'
                                ? 'bg-emerald-50 text-emerald-600'
                                : 'bg-slate-100 text-slate-500'
                            }`}
                          >
                            {app.paymentStatus === 'paid' ? 'Paid' : 'Unpaid'}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* RENDER MODALS */}
      <AnimatePresence>
        {/* ADD APPOINTMENT MODAL */}
        {isBookModalOpen && (
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white rounded-xl w-full max-w-md p-6 border border-slate-200 shadow-lg"
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-base font-bold text-slate-800 flex items-center gap-1.5">
                  <Plus className="h-4 w-4" /> Book Appointment
                </h3>
                <span className="text-xs font-mono text-slate-500 bg-slate-100 px-2 py-0.5 rounded">
                  {selectedDateStr}
                </span>
              </div>

              <form onSubmit={handleBookSubmit} className="space-y-4">
                {/* Patient Selection */}
                <div>
                  <label className="text-xs text-slate-500 font-bold block mb-1">
                    Select {patientLabel} *
                  </label>
                  <select
                    required
                    value={formPatientId}
                    onChange={(e) => setFormPatientId(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-700"
                  >
                    <option value="">-- Choose {patientLabel} --</option>
                    {patients.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.phone})
                      </option>
                    ))}
                  </select>
                </div>

                {/* Staff Selection */}
                <div>
                  <label className="text-xs text-slate-500 font-bold block mb-1">
                    Assign {staffLabel} *
                  </label>
                  <select
                    required
                    value={formStaffId}
                    onChange={(e) => setFormStaffId(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-700"
                  >
                    <option value="">-- Choose {staffLabel} --</option>
                    {staff
                      .filter((st) => {
                        return isClinic ? st.role.includes('GP') || st.role.includes('Director') || st.role.includes('Physio') || st.role.includes('Cardio') : st.role.includes('Stylist') || st.role.includes('Esthetician') || st.role.includes('Therapist');
                      })
                      .map((st) => (
                        <option key={st.id} value={st.id}>
                          {st.name} - {st.specialty}
                        </option>
                      ))}
                  </select>
                </div>

                {/* Service Selection */}
                <div>
                  <label className="text-xs text-slate-500 font-bold block mb-1">
                    Select {serviceLabel} *
                  </label>
                  <select
                    required
                    value={formService}
                    onChange={(e) => handleServiceChange(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-700"
                  >
                    <option value="">-- Choose {serviceLabel} --</option>
                    {servicesList.map((srv) => (
                      <option key={srv.name} value={srv.name}>
                        {srv.name} (${srv.price} • {srv.duration} min)
                      </option>
                    ))}
                  </select>
                </div>

                {/* Date & Time block */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-slate-500 font-bold block mb-1">Start Time</label>
                    <input
                      type="time"
                      required
                      value={formTime}
                      onChange={(e) => setFormTime(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 text-xs text-slate-700"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 font-bold block mb-1">Price ($)</label>
                    <input
                      type="number"
                      required
                      value={formPrice}
                      onChange={(e) => setFormPrice(Number(e.target.value))}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 text-xs text-slate-700"
                    />
                  </div>
                </div>

                {/* Notes */}
                <div>
                  <label className="text-xs text-slate-500 font-bold block mb-1">Appointment Notes</label>
                  <textarea
                    value={formNotes}
                    onChange={(e) => setFormNotes(e.target.value)}
                    placeholder="e.g. skin sensitivities, cardiac follow-up..."
                    rows={2}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 text-xs text-slate-700 resize-none"
                  />
                </div>

                {/* Actions */}
                <div className="flex items-center justify-end gap-2 pt-3">
                  <button
                    type="button"
                    onClick={() => setIsBookModalOpen(false)}
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
                    Confirm Booking
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}

        {/* DETAILED APPOINTMENT ACTION DIALOG */}
        {selectedAppointment && (
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white rounded-xl w-full max-w-md p-6 border border-slate-200 shadow-lg relative"
            >
              {/* Header */}
              <div className="flex items-start justify-between mb-4">
                <div>
                  <span className="text-[10px] font-mono uppercase font-bold tracking-wide text-slate-400">
                    Booking Details
                  </span>
                  <h3 className="text-base font-bold text-slate-800">
                    {selectedAppointment.service}
                  </h3>
                </div>
                <button
                  onClick={() => setSelectedAppointment(null)}
                  className="text-slate-400 hover:text-slate-600 text-sm font-semibold p-1"
                >
                  ✕
                </button>
              </div>

              {/* Patient info card */}
              {(() => {
                const patient = patients.find((p) => p.id === selectedAppointment.patientId);
                const st = staff.find((s) => s.id === selectedAppointment.staffId);

                return (
                  <div className="space-y-4">
                    <div className="bg-slate-50 p-3.5 rounded-xl flex items-center gap-3 border border-slate-100">
                      <img
                        src={patient?.avatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150'}
                        alt={patient?.name}
                        className="w-10 h-10 rounded-full object-cover"
                        referrerPolicy="no-referrer"
                      />
                      <div className="flex-1 min-w-0">
                        <span className="text-xs font-bold text-slate-800 block">
                          {patient?.name}
                        </span>
                        <span className="text-[10px] text-slate-500 font-mono block">
                          {patient?.phone} • {patient?.email}
                        </span>
                        <button
                          onClick={() => {
                            if (patient) {
                              onSelectPatient(patient.id);
                              setSelectedAppointment(null);
                            }
                          }}
                          className="text-[10px] text-teal-600 hover:underline mt-1 font-semibold flex items-center gap-1"
                        >
                          <FileText className="h-3 w-3" /> View Patient Chart
                        </button>
                      </div>
                    </div>

                    {/* Metadata lines */}
                    <div className="grid grid-cols-2 gap-3 text-xs">
                      <div>
                        <span className="text-slate-400 font-semibold block mb-0.5">DATE & TIME</span>
                        <p className="text-slate-700 font-mono font-medium">
                          {selectedAppointment.date}
                        </p>
                        <p className="text-slate-500 font-mono">
                          at {selectedAppointment.time} ({selectedAppointment.duration} mins)
                        </p>
                      </div>
                      <div>
                        <span className="text-slate-400 font-semibold block mb-0.5">{staffLabel.toUpperCase()}</span>
                        <p className="text-slate-700 font-medium">
                          {st?.name}
                        </p>
                        <p className="text-slate-400 text-[10px]">
                          {st?.role}
                        </p>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3 text-xs border-t border-slate-100 pt-3">
                      <div>
                        <span className="text-slate-400 font-semibold block mb-0.5">COST & FEES</span>
                        <p className="text-slate-800 font-bold text-sm">
                          ${selectedAppointment.price.toFixed(2)}
                        </p>
                      </div>
                      <div>
                        <span className="text-slate-400 font-semibold block mb-0.5">PAYMENT</span>
                        <span
                          className={`text-[10px] font-mono px-2 py-0.5 rounded ${
                            selectedAppointment.paymentStatus === 'paid'
                              ? 'bg-emerald-50 text-emerald-600 border border-emerald-100'
                              : 'bg-amber-50 text-amber-600 border border-amber-100'
                          }`}
                        >
                          {selectedAppointment.paymentStatus === 'paid' ? 'Paid / Settled' : 'Unpaid'}
                        </span>
                      </div>
                    </div>

                    {selectedAppointment.notes && (
                      <div className="bg-blue-50/50 p-2.5 rounded-lg border border-blue-100/50 text-[11px] text-slate-600">
                        <strong className="text-slate-700 block mb-0.5">Special Instructions:</strong>
                        {selectedAppointment.notes}
                      </div>
                    )}

                    {/* Action controls */}
                    <div className="pt-3 border-t border-slate-100 space-y-2">
                      <span className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-wide block">
                        Update Status
                      </span>

                      <div className="flex flex-wrap gap-1.5">
                        <button
                          onClick={() => {
                            onUpdateAppointmentStatus(selectedAppointment.id, 'confirmed');
                            setSelectedAppointment(null);
                          }}
                          className="px-2.5 py-1 text-[11px] font-semibold bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-100 rounded-lg transition"
                        >
                          ✓ Confirm
                        </button>
                        <button
                          onClick={() => {
                            onUpdateAppointmentStatus(selectedAppointment.id, 'completed');
                            setSelectedAppointment(null);
                          }}
                          className="px-2.5 py-1 text-[11px] font-semibold bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-100 rounded-lg transition"
                        >
                          ✓ Check-in / Complete
                        </button>
                        <button
                          onClick={() => {
                            onUpdateAppointmentStatus(selectedAppointment.id, 'cancelled');
                            setSelectedAppointment(null);
                          }}
                          className="px-2.5 py-1 text-[11px] font-semibold bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-100 rounded-lg transition"
                        >
                          ✕ Cancel Visit
                        </button>
                      </div>

                      {selectedAppointment.paymentStatus !== 'paid' && (
                        <div className="pt-2">
                          <button
                            onClick={() => {
                              onUpdatePaymentStatus(selectedAppointment.id, 'paid');
                              setSelectedAppointment(null);
                            }}
                            className="w-full flex items-center justify-center gap-1 px-3 py-2 text-xs font-bold text-white bg-slate-900 hover:bg-slate-800 rounded-xl transition"
                          >
                            <DollarSign className="h-3.5 w-3.5" /> Mark as Paid (Cash/Terminal)
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
