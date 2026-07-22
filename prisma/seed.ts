import { LocationType, UserRole } from '@prisma/client';
import { hash } from '@node-rs/argon2';
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';

import { prismaAdmin, withoutRls } from '@/lib/db';
import { encryptField } from '@/lib/crypto';
import {
  INITIAL_PATIENTS,
  INITIAL_STAFF,
  MEDICAL_SERVICES,
  SALON_SERVICES,
} from '@/lib/seed-data';

loadEnv({ path: '.env.local', override: true });

const DEV_PASSWORD = process.env.DEV_USER_PASSWORD ?? 'devpass123';

// Prototype staff ID → destination location.
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

function parseHours(hours: string): { start: Date; end: Date } {
  const [rawStart, rawEnd] = hours.split(/\s*-\s*/);
  const toTime = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00Z`);
  return { start: toTime(rawStart), end: toTime(rawEnd) };
}

async function main() {
  console.log('→ Resetting all tenant data…');
  await withoutRls(async (tx) => {
    await tx.treatmentHistory.deleteMany();
    await tx.staffAvailability.deleteMany();
    await tx.staff.deleteMany();
    await tx.customer.deleteMany();
    await tx.service.deleteMany();
    await tx.location.deleteMany();
    await tx.membership.deleteMany();
    await tx.appUser.deleteMany();
    await tx.organization.deleteMany();
  });

  const passwordHash = await hash(DEV_PASSWORD);

  // ---------------------------------------------------------------------------
  // Primary organization: Grand Medical & Aurora Spa Group
  // ---------------------------------------------------------------------------
  const { org, clinic, salon, ownerId, receptionId } = await withoutRls(async (tx) => {
    console.log('→ Creating primary organization + locations…');
    const org = await tx.organization.create({
      data: { name: 'Grand Medical & Aurora Spa Group' },
    });

    const [clinic, salon] = await Promise.all([
      tx.location.create({
        data: { organizationId: org.id, type: 'clinic', name: 'Grand Medical Suite' },
      }),
      tx.location.create({
        data: { organizationId: org.id, type: 'salon', name: 'Aurora Salon & Spa' },
      }),
    ]);

    console.log('→ Seeding services…');
    await tx.service.createMany({
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

    console.log('→ Seeding staff + availability…');
    for (const s of INITIAL_STAFF) {
      const dest = STAFF_LOCATION[s.id] === 'clinic' ? clinic : salon;
      const { start, end } = parseHours(s.availability.hours);
      await tx.staff.create({
        data: {
          organizationId: org.id,
          locationId: dest.id,
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

    console.log('→ Seeding customers + treatment history (allergies + notes encrypted)…');
    for (const p of INITIAL_PATIENTS) {
      await tx.customer.create({
        data: {
          organizationId: org.id,
          name: p.name,
          email: p.email,
          phone: p.phone,
          dob: new Date(p.dob),
          gender: p.gender,
          avatarUrl: p.avatar,
          joinedDate: new Date(p.joinedDate),
          allergies: encryptField(p.allergies),
          clinicalNotes: encryptField(p.notes),
          consentAt: new Date(),
          consentVersion: '1.0',
          treatmentHistory: { create: p.history.map((label) => ({ label })) },
        },
      });
    }

    console.log('→ Seeding dev users + memberships…');
    const owner = await tx.appUser.create({
      data: {
        authProvider: 'credentials',
        authSubject: 'owner@bookpitch.dev',
        email: 'owner@bookpitch.dev',
        fullName: 'Dev Owner',
        passwordHash,
      },
    });
    const reception = await tx.appUser.create({
      data: {
        authProvider: 'credentials',
        authSubject: 'reception@bookpitch.dev',
        email: 'reception@bookpitch.dev',
        fullName: 'Dev Receptionist',
        passwordHash,
      },
    });
    await tx.membership.createMany({
      data: [
        { organizationId: org.id, userId: owner.id, role: UserRole.owner },
        { organizationId: org.id, userId: reception.id, role: UserRole.receptionist },
      ],
    });

    return { org, clinic, salon, ownerId: owner.id, receptionId: reception.id };
  });

  // ---------------------------------------------------------------------------
  // Isolation Corp — a second organization used by the RLS test to prove
  // that tenant_isolation policies actually reject cross-org reads.
  // ---------------------------------------------------------------------------
  const { isolationOrg } = await withoutRls(async (tx) => {
    console.log('→ Creating isolation-test organization…');
    const iso = await tx.organization.create({ data: { name: 'Isolation Corp' } });
    await tx.location.create({
      data: { organizationId: iso.id, type: 'clinic', name: 'Isolation Clinic' },
    });
    await tx.customer.create({
      data: {
        organizationId: iso.id,
        name: 'Do Not Leak',
        email: 'secret@isolation.dev',
      },
    });
    const isoOwner = await tx.appUser.create({
      data: {
        authProvider: 'credentials',
        authSubject: 'isolation@bookpitch.dev',
        email: 'isolation@bookpitch.dev',
        fullName: 'Isolation Owner',
        passwordHash,
      },
    });
    await tx.membership.create({
      data: { organizationId: iso.id, userId: isoOwner.id, role: UserRole.owner },
    });
    return { isolationOrg: iso };
  });

  const counts = await withoutRls(async (tx) => ({
    organizations: await tx.organization.count(),
    locations: await tx.location.count(),
    staff: await tx.staff.count(),
    staffAvailability: await tx.staffAvailability.count(),
    services: await tx.service.count(),
    customers: await tx.customer.count(),
    treatmentHistory: await tx.treatmentHistory.count(),
    appUsers: await tx.appUser.count(),
    memberships: await tx.membership.count(),
  }));
  console.log('✔ Seed complete:', counts);
  console.log('  primary org  :', org.id);
  console.log('  clinic       :', clinic.id, ' salon:', salon.id);
  console.log('  dev users    :', { ownerId, receptionId });
  console.log('  isolation org:', isolationOrg.id);
  console.log('  password     :', DEV_PASSWORD, '(dev-only, in .env.local)');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prismaAdmin.$disconnect();
  });
