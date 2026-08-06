import { Patient, Staff, Appointment, AppNotification, RevenueRecord } from '@/lib/types';

// Let's establish today's date dynamically as 2026-07-21
export const TODAY_STR = '2026-07-21';

export const MEDICAL_SERVICES = [
  { name: 'General Consultation', price: 120, duration: 30, category: 'General' },
  { name: 'Cardiology Assessment', price: 280, duration: 45, category: 'Specialist' },
  { name: 'Dermatological Exam', price: 150, duration: 30, category: 'Specialist' },
  { name: 'Pediatric Checkup', price: 110, duration: 30, category: 'General' },
  { name: 'Dental Cleaning & Fill', price: 180, duration: 60, category: 'Dental' },
  { name: 'Physiotherapy Session', price: 95, duration: 45, category: 'Therapy' },
];

export const SALON_SERVICES = [
  { name: 'Luxury Balayage & Cut', price: 240, duration: 120, category: 'Hair' },
  { name: 'Signature Hydrafacial', price: 160, duration: 60, category: 'Skin' },
  { name: 'Gel Manicure & Pedicure', price: 90, duration: 75, category: 'Nails' },
  { name: 'Swedish Full Body Massage', price: 130, duration: 60, category: 'Body' },
  { name: 'Eyelash Extensions (Full)', price: 150, duration: 90, category: 'Eyes' },
  { name: 'Beard Trim & Hot Towel Shave', price: 65, duration: 45, category: 'Hair' },
];

export const INITIAL_PATIENTS: Patient[] = [
  {
    id: 'p1',
    name: 'Sarah Jenkins',
    email: 'sarah.j@example.com',
    phone: '+1 (555) 234-5678',
    dob: '1989-05-14',
    gender: 'Female',
    joinedDate: '2024-03-12',
    avatar: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150',
    notes: 'Penicillin allergy. Prefers afternoon bookings. Very sensitive skin.',
    history: [
      'Annual Physical (Jan 2026)',
      'Derm Check (Nov 2025)',
      'Facial Glow Treatment (Jun 2026)',
    ],
    allergies: 'Penicillin, Tree nuts',
  },
  {
    id: 'p2',
    name: 'Michael Chen',
    email: 'm.chen@example.com',
    phone: '+1 (555) 345-6789',
    dob: '1975-10-22',
    gender: 'Male',
    joinedDate: '2023-11-05',
    avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150',
    notes: 'Hypertension history. Takes Metoprolol. Prefers quiet clinic rooms.',
    history: [
      'Cardio Review (Mar 2026)',
      'Teeth Cleaning (Feb 2026)',
      'Swedish Massage (May 2026)',
    ],
    allergies: 'None',
  },
  {
    id: 'p3',
    name: 'Elena Rostova',
    email: 'elena.ros@example.com',
    phone: '+1 (555) 456-7890',
    dob: '1994-08-30',
    gender: 'Female',
    joinedDate: '2025-01-19',
    avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150',
    notes: 'No medical conditions. Uses retinol (warn before peel treatments).',
    history: [
      'Chemical Peel (Apr 2026)',
      'General Consultation (Mar 2026)',
      'Hydrafacial (Jul 2026)',
    ],
    allergies: 'Aspirin (minor reaction)',
  },
  {
    id: 'p4',
    name: 'David Brooks',
    email: 'd.brooks@example.com',
    phone: '+1 (555) 567-8901',
    dob: '1981-02-17',
    gender: 'Male',
    joinedDate: '2025-06-21',
    avatar: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150',
    notes: 'Active runner, chronic lower back stiffness. Prefers firm pressure.',
    history: ['Physio Consultation (Jun 2026)', 'Deep Tissue Massage (Jul 2026)'],
    allergies: 'Adhesive tape',
  },
  {
    id: 'p5',
    name: 'Amina Al-Mansoor',
    email: 'amina.am@example.com',
    phone: '+1 (555) 678-9012',
    dob: '2001-12-03',
    gender: 'Female',
    joinedDate: '2025-10-02',
    avatar: 'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=150',
    notes: 'Prefers organic/vegan beauty products. Looking for a new hair color routine.',
    history: ['Balayage & Styling (Dec 2025)', 'Pedicure (Apr 2026)'],
    allergies: 'Lactose',
  },
];

export const INITIAL_STAFF: Staff[] = [
  {
    id: 's1',
    name: 'Dr. Helen Vance',
    role: 'Medical Director / GP',
    specialty: 'Family Medicine',
    email: 'h.vance@clinic.com',
    phone: '+1 (555) 123-0001',
    avatar: 'https://images.unsplash.com/photo-1559839734-2b71ea197ec2?w=150',
    color: '#0d9488', // Teal 600
    rating: 4.9,
    availability: {
      days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
      hours: '08:30 - 16:30',
    },
  },
  {
    id: 's2',
    name: 'Dr. Marcus Sterling',
    role: 'Senior Cardiologist',
    specialty: 'Heart & Vascular Care',
    email: 'm.sterling@clinic.com',
    phone: '+1 (555) 123-0002',
    avatar: 'https://images.unsplash.com/photo-1622253692010-333f2da6031d?w=150',
    color: '#2563eb', // Blue 600
    rating: 4.8,
    availability: {
      days: ['Monday', 'Wednesday', 'Friday'],
      hours: '09:00 - 17:00',
    },
  },
  {
    id: 's3',
    name: 'Chloe Fontaine',
    role: 'Lead Hair Stylist & Colorist',
    specialty: 'Balayage & Color Correction',
    email: 'chloe@salon.com',
    phone: '+1 (555) 123-0003',
    avatar: 'https://images.unsplash.com/photo-1580489944761-15a19d654956?w=150',
    color: '#db2777', // Pink 600
    rating: 4.95,
    availability: {
      days: ['Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
      hours: '10:00 - 19:00',
    },
  },
  {
    id: 's4',
    name: 'Lucas Dupont',
    role: 'Esthetician & Skin Therapist',
    specialty: 'Hydrafacials & Peels',
    email: 'lucas@salon.com',
    phone: '+1 (555) 123-0004',
    avatar: 'https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?w=150',
    color: '#84cc16', // Lime 500
    rating: 4.75,
    availability: {
      days: ['Monday', 'Tuesday', 'Thursday', 'Friday'],
      hours: '09:00 - 18:00',
    },
  },
  {
    id: 's5',
    name: 'Rachel Kross',
    role: 'Senior Physiotherapist',
    specialty: 'Sports Injury Rehab',
    email: 'r.kross@clinic.com',
    phone: '+1 (555) 123-0005',
    avatar: 'https://images.unsplash.com/photo-1594824813573-246434de83fb?w=150',
    color: '#4f46e5', // Indigo 600
    rating: 4.85,
    availability: {
      days: ['Tuesday', 'Thursday', 'Friday'],
      hours: '08:00 - 16:00',
    },
  },
];

export const INITIAL_APPOINTMENTS: Appointment[] = [
  {
    id: 'a1',
    patientId: 'p1',
    staffId: 's1',
    date: '2026-07-21', // Today
    time: '09:30',
    duration: 30,
    service: 'General Consultation',
    price: 120,
    status: 'completed',
    paymentStatus: 'paid',
    reminderSent: true,
    notes: 'Regular checkup. Patient complained of mild seasonal allergies.',
  },
  {
    id: 'a2',
    patientId: 'p2',
    staffId: 's2',
    date: '2026-07-21', // Today
    time: '11:00',
    duration: 45,
    service: 'Cardiology Assessment',
    price: 280,
    status: 'confirmed',
    paymentStatus: 'unpaid',
    reminderSent: true,
    notes: 'Follow-up check after dosage increase.',
  },
  {
    id: 'a3',
    patientId: 'p3',
    staffId: 's4',
    date: '2026-07-21', // Today
    time: '14:00',
    duration: 60,
    service: 'Signature Hydrafacial',
    price: 160,
    status: 'confirmed',
    paymentStatus: 'paid',
    reminderSent: true,
    notes: 'Avoid strong salicylic wash, client uses over-the-counter retinol.',
  },
  {
    id: 'a4',
    patientId: 'p4',
    staffId: 's5',
    date: '2026-07-22', // Tomorrow
    time: '10:00',
    duration: 45,
    service: 'Physiotherapy Session',
    price: 95,
    status: 'confirmed',
    paymentStatus: 'unpaid',
    reminderSent: false,
    notes: 'Focus on lower lumbar recovery techniques.',
  },
  {
    id: 'a5',
    patientId: 'p5',
    staffId: 's3',
    date: '2026-07-22', // Tomorrow
    time: '13:00',
    duration: 120,
    service: 'Luxury Balayage & Cut',
    price: 240,
    status: 'pending',
    paymentStatus: 'unpaid',
    reminderSent: false,
    notes: 'Consultation about changing dark brown hair to honey blonde.',
  },
  {
    id: 'a6',
    patientId: 'p1',
    staffId: 's3',
    date: '2026-07-23', // Day after tomorrow
    time: '11:30',
    duration: 75,
    service: 'Gel Manicure & Pedicure',
    price: 90,
    status: 'confirmed',
    paymentStatus: 'unpaid',
    reminderSent: false,
    notes: 'Wants classic red color and light skin scrub.',
  },
  {
    id: 'a7',
    patientId: 'p2',
    staffId: 's1',
    date: '2026-07-20', // Yesterday
    time: '15:00',
    duration: 30,
    service: 'General Consultation',
    price: 120,
    status: 'completed',
    paymentStatus: 'paid',
    reminderSent: true,
    notes: 'Prescription refill processed successfully.',
  },
];

export const INITIAL_NOTIFICATIONS: AppNotification[] = [
  {
    id: 'n1',
    title: 'New Booking Request',
    message: 'Amina Al-Mansoor requested Luxury Balayage & Cut with Chloe Fontaine.',
    time: '10 mins ago',
    type: 'booking',
    read: false,
  },
  {
    id: 'n2',
    title: 'Payment Confirmed',
    message: 'Sarah Jenkins paid $120.00 for General Consultation.',
    time: '1 hour ago',
    type: 'payment',
    read: false,
  },
  {
    id: 'n3',
    title: 'Reminder Dispatched',
    message: 'SMS automated reminder sent to Michael Chen for Cardiology Assessment.',
    time: '3 hours ago',
    type: 'reminder',
    read: true,
  },
  {
    id: 'n4',
    title: 'Offline Sync Complete',
    message: '2 appointments synchronized with cloud server database successfully.',
    time: '4 hours ago',
    type: 'sync',
    read: true,
  },
];

export const REVENUE_DATA: RevenueRecord[] = [
  { date: 'Jul 15', revenue: 780, bookings: 5, clinicType: 'clinic' },
  { date: 'Jul 16', revenue: 920, bookings: 6, clinicType: 'clinic' },
  { date: 'Jul 17', revenue: 1140, bookings: 8, clinicType: 'clinic' },
  { date: 'Jul 18', revenue: 850, bookings: 5, clinicType: 'salon' },
  { date: 'Jul 19', revenue: 1250, bookings: 9, clinicType: 'salon' },
  { date: 'Jul 20', revenue: 1480, bookings: 11, clinicType: 'clinic' },
  { date: 'Jul 21', revenue: 1850, bookings: 13, clinicType: 'clinic' },
];
