import { hash } from '@node-rs/argon2';
import { withoutRls } from '@/lib/db';
import { InvalidInputError } from '@/lib/auth';
import { log } from '@/lib/logger';

// -----------------------------------------------------------------------------
// Self-service org onboarding. Given (email, password, orgName, locationName,
// locationType), atomically:
//   1) Create the AppUser (credentials, argon2 hash).
//   2) Create the Organization.
//   3) Create the initial Location.
//   4) Insert the owner Membership.
// Returns identifiers so the caller can immediately signIn().
//
// Bypasses RLS (withoutRls) because there IS no session yet — the org this
// user will belong to doesn't exist until this call returns.
// -----------------------------------------------------------------------------

export type OnboardInput = {
  email: string;
  password: string;
  fullName: string;
  orgName: string;
  locationName?: string;
  locationType?: 'clinic' | 'salon';
};

export type OnboardResult = {
  userId: string;
  organizationId: string;
  locationId: string;
};

export async function onboardOrg(input: OnboardInput): Promise<OnboardResult> {
  const email = input.email.trim().toLowerCase();
  const fullName = input.fullName.trim();
  const orgName = input.orgName.trim();
  const locationName = (input.locationName ?? 'Main location').trim();
  const locationType = input.locationType ?? 'clinic';

  if (!email || !email.includes('@') || email.length > 254) {
    throw new InvalidInputError('email is invalid');
  }
  if (!input.password || input.password.length < 8) {
    throw new InvalidInputError('password must be at least 8 characters');
  }
  if (!fullName) throw new InvalidInputError('fullName is required');
  if (!orgName) throw new InvalidInputError('orgName is required');
  if (locationType !== 'clinic' && locationType !== 'salon') {
    throw new InvalidInputError('locationType must be clinic or salon');
  }

  const existing = await withoutRls((tx) =>
    tx.appUser.findUnique({ where: { email }, select: { id: true } }),
  );
  if (existing) throw new InvalidInputError('email already registered');

  const passwordHash = await hash(input.password);

  return withoutRls(async (tx) => {
    const org = await tx.organization.create({ data: { name: orgName } });
    const location = await tx.location.create({
      data: { organizationId: org.id, type: locationType, name: locationName },
    });
    const user = await tx.appUser.create({
      data: {
        authProvider: 'credentials',
        authSubject: email,
        email,
        fullName,
        passwordHash,
      },
    });
    await tx.membership.create({
      data: { organizationId: org.id, userId: user.id, role: 'owner' },
    });
    log.info('onboard.ok', { organizationId: org.id, userId: user.id });
    return { userId: user.id, organizationId: org.id, locationId: location.id };
  });
}
