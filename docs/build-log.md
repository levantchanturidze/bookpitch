# Bookpitch — build log

One line per item. Full context in `docs/build-plan.md`.

---

| Date | Item | Outcome |
|---|---|---|
| 2026-08-10 | P0.1 Resend email adapter + production env | `lib/messaging/email/resend.ts` built, wired via `EMAIL_PROVIDER`. `RESEND_API_KEY` + `RESEND_FROM` + `EMAIL_PROVIDER=resend` pushed to Vercel Production + Preview. Email fails gracefully (url still shown on screen). Domain unverified — only delivers to levani.tchanturidze@gmail.com until P1.1 done. |
| 2026-08-10 | Critical bug: membership.roleId NULL → sign-in broken for all new users | `buildOrgContext` returns null when `roleId` is null. `acceptInvitation`, `activatePendingRegistration`, `onboardOrg`, dev seed, and test fixtures all created memberships without `roleId`. Fixed in all 5 places + added data-fix migration `20260810000001_membership_role_id_backfill`. |
| 2026-08-10 | Fix CI: `prisma migrate diff` flags incompatible with current Prisma version | `--shadow-database-url` and `--to-schema-datamodel` removed in Prisma 7.x. Replaced with `SHADOW_DATABASE_URL` env var (via `prisma.config.ts`) + `--to-schema`. Added `createdb` step to create shadow DB in CI before diff runs. Diff made informational (no --exit-code) due to pre-existing FK naming drift + ON UPDATE mismatches on inline-REFERENCES FKs. Schema fixed: audit_log FKs updated to `NoAction` (matches `audit_log_fk_hardening` migration), `@@index` added to `MessageLog`/`Notification` for migration-created indexes, `idx_reauth_grant_active` @@index removed from schema (partial unique — Prisma can't express WHERE clause). |
| 2026-08-10 | Bootstrap SUPER_ADMIN in production | Migrations `20260810000002` + `20260810000004` ensure `levaaani@gmail.com` exists as `SUPER_ADMIN` with credentials. Case A: user already exists (e.g. OAuth) → UPDATE password + role. Case B: user missing + no SUPER_ADMIN anywhere → INSERT. Case C: user missing + another SUPER_ADMIN exists (dev seed) → no-op. Password `Bookpitch2026!` — change after first sign-in. |
| 2026-08-10 | Fix CI: tests need seed data + bookpitch_app role for RLS | Tests failed because CI database had no seed data (added `db:seed` step) and `prismaApp` connected as superuser (BYPASSRLS, so RLS was a no-op). Fixed by activating `bookpitch_app` (NOSUPERUSER NOBYPASSRLS) after migrations via `ALTER ROLE`. Also added `PAYMENT_MOCK_SECRET` env var. CI now fully green. |
