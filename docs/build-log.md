# Bookpitch — build log

One line per item. Full context in `docs/build-plan.md`.

---

| Date | Item | Outcome |
|---|---|---|
| 2026-08-10 | P0.1 Resend email adapter + production env | `lib/messaging/email/resend.ts` built, wired via `EMAIL_PROVIDER`. `RESEND_API_KEY` + `RESEND_FROM` + `EMAIL_PROVIDER=resend` pushed to Vercel Production + Preview. Email fails gracefully (url still shown on screen). Domain unverified — only delivers to levani.tchanturidze@gmail.com until P1.1 done. |
