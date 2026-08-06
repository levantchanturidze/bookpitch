// -----------------------------------------------------------------------------
// Global (non-tenant) rate limiting via the platform_rate_limit table.
//
// Used by:
//   • onboard abuse protection — bucket "onboard:ip:<ip>"
//   • platform reauth brute-force — bucket "reauth:<userId>" (in
//     password-reauth.ts directly via $queryRaw for the atomic upsert)
//
// consumeGlobalBucket(bucket, limit, windowMs):
//   Atomically increments the counter for `bucket` in the current window.
//   Throws InvalidInputError if the counter exceeds `limit`.
// -----------------------------------------------------------------------------

import { unsafePrismaAdmin } from '@/lib/db';
import { InvalidInputError } from '@/lib/auth';

export async function consumeGlobalBucket(
  bucket: string,
  limit: number,
  windowMs: number,
): Promise<void> {
  const now = Date.now();
  const windowStart = new Date(Math.floor(now / windowMs) * windowMs);

  const row = await unsafePrismaAdmin.$queryRaw<Array<{ count: number }>>`
    INSERT INTO platform_rate_limit (bucket, window_start, count)
    VALUES (${bucket}, ${windowStart}, 1)
    ON CONFLICT (bucket, window_start) DO UPDATE
      SET count = platform_rate_limit.count + 1
    RETURNING count
  `;
  const count = row[0]?.count ?? 0;
  if (count > limit) {
    throw new InvalidInputError('rate limit exceeded, try again later');
  }
}
