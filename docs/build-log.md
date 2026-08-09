# Bookpitch — build log

One line per item. Full context in `docs/build-plan.md`.

---

| Date | Item | Outcome |
|---|---|---|
| 2026-08-10 | P0.1 Resend email adapter + production env | `lib/messaging/email/resend.ts` built, wired via `EMAIL_PROVIDER`. `RESEND_API_KEY` + `RESEND_FROM` + `EMAIL_PROVIDER=resend` pushed to Vercel Production + Preview. Email fails gracefully (url still shown on screen). Domain unverified — only delivers to levani.tchanturidze@gmail.com until P1.1 done. |
| 2026-08-10 | Critical bug: membership.roleId NULL → sign-in broken for all new users | `buildOrgContext` returns null when `roleId` is null. `acceptInvitation`, `activatePendingRegistration`, `onboardOrg`, dev seed, and test fixtures all created memberships without `roleId`. Fixed in all 5 places + added data-fix migration `20260810000001_membership_role_id_backfill`. |
| 2026-08-10 | Fix CI: `prisma migrate diff` flags incompatible with current Prisma version | `--shadow-database-url` and `--to-schema-datamodel` removed in Prisma 7.x. Replaced with `SHADOW_DATABASE_URL` env var (via `prisma.config.ts`) + `--to-schema`. Added `createdb` step to create shadow DB in CI before diff runs. |
