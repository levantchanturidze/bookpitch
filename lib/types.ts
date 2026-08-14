export type WorkspaceMode = 'clinic' | 'salon';

export type UserRole = 'owner' | 'practitioner' | 'receptionist';

export interface Patient {
  id: string;
  name: string;
  email: string;
  phone: string;
  dob: string;
  gender: string;
  joinedDate: string;
  avatar: string;
  // Dynamic labels based on clinic/salon
  notes: string;
  history: string[]; // medical history or beauty treatment history
  allergies?: string; // or skin sensitivities
}

export interface Staff {
  id: string;
  name: string;
  role: string; // e.g., 'Doctor', 'Therapist', 'Stylist'
  specialty: string;
  email: string;
  phone: string;
  avatar: string;
  color: string; // Theme color for calendar display
  rating: number;
  availability: {
    days: string[]; // e.g., ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
    hours: string; // e.g., '09:00 - 17:00'
  };
}

export interface Appointment {
  id: string;
  patientId: string;
  staffId: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  duration: number; // in minutes
  service: string;
  price: number;
  status: 'pending' | 'confirmed' | 'completed' | 'cancelled';
  paymentStatus: 'unpaid' | 'paid' | 'refunding';
  reminderSent: boolean;
  notes?: string;
}

export interface AppNotification {
  id: string;
  title: string;
  message: string;
  time: string;
  type: 'booking' | 'reminder' | 'payment' | 'system' | 'sync';
  read: boolean;
}

export interface RevenueRecord {
  date: string;
  revenue: number;
  bookings: number;
  clinicType: WorkspaceMode;
}

export interface SyncQueueItem {
  id: string;
  action: 'create' | 'update' | 'delete';
  entity: 'appointment' | 'patient' | 'staff';
  data: unknown;
  timestamp: string;
}
