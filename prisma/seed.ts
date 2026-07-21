import { PrismaClient, LocationType } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import {
  INITIAL_PATIENTS,
  INITIAL_STAFF,
  MEDICAL_SERVICES,
  SALON_SERVICES,
} from '@/lib/seed-data';

loadEnv({ path: '.env.local', override: true });

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// Prototype staff ID → destination location. The clinic gets the two doctors
// + physiotherapist; the salon gets stylist + esthetician.
const STAFF_LOCATION: Record<string, LocationType> = {
  s1: 'clinic',
  s2: 'clinic',
  s3: 'salon',
  s4: 'salon',
  s5: 'clinic',
};

// Weekday-name → PG weekday number (Sun=0, matches schema.sql CHECK).
const WEEKDAY_INDEX: Record<string, number> = {
  Sunday: 0,
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
};

// "09:00 - 17:00" → { start: Date, end: Date } using 1970-01-01 as the
// arbitrary date part (Prisma's @db.Time uses the time portion only).
function parseHours(hours: string): { start: Date; end: Date } {
  const [rawStart, rawEnd] = hours.split(/\s*-\s*/);
  const toTime = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00Z`);
  return { start: toTime(rawStart), end: toTime(rawEnd) };
}

async function main() {
  console.log('→ Resetting tenant tables…');

  // Order matters: clear children first to satisfy FKs. In dev the seed is
  // idempotent — re-runs produce the same state.
  await prisma.$transaction([
    prisma.treatmentHistory.deleteMany(),
    prisma.staffAvailability.deleteMany(),
    prisma.staff.deleteMany(),
    prisma.customer.deleteMany(),
    prisma.service.deleteMany(),
    prisma.location.deleteMany(),
    prisma.organization.deleteMany(),
  ]);

  console.log('→ Creating organization + locations…');
  const org = await prisma.organization.create({
    data: { name: 'Grand Medical & Aurora Spa Group' },
  });

  const [clinic, salon] = await Promise.all([
    prisma.location.create({
      data: {
        organizationId: org.id,
        type: 'clinic',
        name: 'Grand Medical Suite',
      },
    }),
    prisma.location.create({
      data: {
        organizationId: org.id,
        type: 'salon',
        name: 'Aurora Salon & Spa',
      },
    }),
  ]);

  console.log('→ Seeding services (per location)…');
  await prisma.service.createMany({
    data: [
      ...MEDICAL_SERVICES.map((s) => ({
        organizationId: org.id,
        locationId: clinic.id,
        name: s.name,
        category: s.category,
        price: s.price,
        durationMinutes: s.duration,
      })),
      ...SALON_SERVICES.map((s) => ({
        organizationId: org.id,
        locationId: salon.id,
        name: s.name,
        category: s.category,
        price: s.price,
        durationMinutes: s.duration,
      })),
    ],
  });

  console.log('→ Seeding staff + availability windows…');
  for (const s of INITIAL_STAFF) {
    const destination = STAFF_LOCATION[s.id] === 'clinic' ? clinic : salon;
    const { start, end } = parseHours(s.availability.hours);

    await prisma.staff.create({
      data: {
        organizationId: org.id,
        locationId: destination.id,
        name: s.name,
        roleTitle: s.role,
        specialty: s.specialty,
        email: s.email,
        phone: s.phone,
        avatarUrl: s.avatar,
        calendarColor: s.color,
        rating: s.rating,
        availability: {
          create: s.availability.days.map((day) => ({
            weekday: WEEKDAY_INDEX[day],
            startTime: start,
            endTime: end,
          })),
        },
      },
    });
  }

  console.log('→ Seeding customers + treatment history…');
  for (const p of INITIAL_PATIENTS) {
    await prisma.customer.create({
      data: {
        organizationId: org.id,
        name: p.name,
        email: p.email,
        phone: p.phone,
        dob: new Date(p.dob),
        gender: p.gender,
        avatarUrl: p.avatar,
        joinedDate: new Date(p.joinedDate),
        allergies: p.allergies,
        clinicalNotes: p.notes,
        treatmentHistory: {
          create: p.history.map((label) => ({ label })),
        },
      },
    });
  }

  const counts = {
    organizations: await prisma.organization.count(),
    locations: await prisma.location.count(),
    staff: await prisma.staff.count(),
    staffAvailability: await prisma.staffAvailability.count(),
    services: await prisma.service.count(),
    customers: await prisma.customer.count(),
    treatmentHistory: await prisma.treatmentHistory.count(),
  };
  console.log('✔ Seed complete:', counts);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
