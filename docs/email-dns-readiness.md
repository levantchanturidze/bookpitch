# Email deliverability and domain readiness (Phase 15.5)

Status: **EXTERNAL VERIFICATION BLOCKED** — the changes below are DNS and
Resend-dashboard actions. No DNS record was created, modified or deleted by
this phase; doing so requires separate explicit authorisation.

## 1. Observed DNS state

Captured 2026-08-18T19:22:15Z against resolver `8.8.8.8`. Reproduce with
`dig @8.8.8.8 +short <TYPE> <NAME>`.

| Name | Type | Value |
|---|---|---|
| `bookpitch.ge` | A | `216.198.79.65`, `216.198.79.1` (Vercel) |
| `bookpitch.ge` | NS | `ns1.vercel-dns.com.`, `ns2.vercel-dns.com.` |
| `bookpitch.ge` | TXT | **absent** |
| `bookpitch.ge` | MX | **absent** |
| `_dmarc.bookpitch.ge` | TXT | **absent** |
| `send.bookpitch.ge` | TXT | **absent** |
| `send.bookpitch.ge` | MX | **absent** |
| `_dmarc.send.bookpitch.ge` | TXT | `v=DMARC1; p=none; rua=mailto:dmarc@bookpitch.ge` |
| `resend._domainkey.bookpitch.ge` | TXT | **absent** |

DNS is authoritative on Vercel, so every record below is added in the Vercel
DNS panel for `bookpitch.ge`.

## 2. What this means

Three findings, in order of severity.

**The sending domain is not verified.** There is no DKIM key at
`resend._domainkey.bookpitch.ge` and no SPF record anywhere on the domain.
`lib/messaging/email/resend.ts` sends with whatever `RESEND_FROM` holds. If
that is an `@bookpitch.ge` address, Resend will refuse to send from an
unverified domain; if it is a `@resend.dev` sandbox address, mail sends but
comes from someone else's domain and is unsuitable for production. Either way,
**production email delivery is currently unproven**, and the production monitor
confirms nothing has exercised it: `outbox pending=0, dead=0` and "no audit
digest mail has ever been queued" as of run 32172833269.

This is not detected by the existing configuration contract.
`REQUIRED_EMAIL_ENV` in `lib/ops-metrics.ts` checks that `EMAIL_PROVIDER`,
`RESEND_API_KEY` and `RESEND_FROM` are *set*. A set-but-unverified sender
passes that check, which is why `missingEmailEnv=0` while the domain is not
actually able to send.

**No organisational DMARC policy.** `_dmarc.bookpitch.ge` is absent, so the
apex domain publishes no policy. A subdomain policy exists at
`_dmarc.send.bookpitch.ge`, but a subdomain record does not substitute for the
organisational one: receivers look up the policy at the organisational domain
and only fall back to `sp=` from there.

**The DMARC reporting address cannot receive mail.** The existing record points
`rua` at `dmarc@bookpitch.ge`, and `bookpitch.ge` publishes no MX record.
Aggregate reports sent there will bounce, so the monitoring loop that `p=none`
exists to provide produces nothing.

## 3. Records to add

Do not apply these without authorisation. Values marked `<from Resend>` are
issued by the Resend dashboard when the domain is added — they are
account-specific and must be copied from there, not guessed.

### 3a. Verify the sending domain (launch blocker)

In Resend → Domains → Add `bookpitch.ge`, then publish exactly what it issues:

| Name | Type | Value |
|---|---|---|
| `resend._domainkey` | TXT | `<from Resend — DKIM public key>` |
| `send` | TXT | `<from Resend — usually v=spf1 include:amazonses.com ~all>` |
| `send` | MX | `<from Resend — bounce handling, priority 10>` |

Then set `RESEND_FROM` to an address at the verified domain, e.g.
`Bookpitch <no-reply@bookpitch.ge>`. Confirm the domain shows **Verified** in
Resend before treating email as working.

### 3b. Organisational DMARC (launch blocker)

| Name | Type | Value |
|---|---|---|
| `_dmarc` | TXT | `v=DMARC1; p=none; rua=mailto:<reportable-mailbox>; fo=1; adkim=s; aspf=s` |

`<reportable-mailbox>` must be an address that actually receives mail. Options,
cheapest first:

1. An external mailbox you already own on a different domain. DMARC permits
   this, but the receiving domain must authorise it with a record of the form
   `bookpitch.ge._report._dmarc.<their-domain> TXT "v=DMARC1"` — without that,
   conforming reporters refuse to send.
2. Add MX for `bookpitch.ge` pointing at a real mail provider and use
   `dmarc@bookpitch.ge` as it currently claims.
3. A hosted DMARC reporting service. Several have free tiers; enabling a paid
   one is out of scope for this phase.

Leaving `rua` pointing at an unreachable address is worse than omitting it —
it looks like monitoring while delivering nothing.

### 3c. Fix the subdomain policy

Once 3a and 3b are live and reports confirm alignment, the existing
`_dmarc.send.bookpitch.ge` record should either be removed (letting the
organisational `sp=` govern) or tightened in step with the apex policy. Leaving
`p=none` there indefinitely means the subdomain that actually sends mail is the
one with no enforcement.

## 4. Rollout and TTL

- Vercel DNS serves a 60-second TTL by default, so changes propagate in
  minutes. Confirm with `dig @8.8.8.8 +short TXT _dmarc.bookpitch.ge` rather
  than a browser.
- Publish DKIM/SPF **before** DMARC enforcement. Enforcement against
  unauthenticated mail rejects your own messages.
- Stay at `p=none` for at least one full reporting cycle (reports arrive
  daily). Only move to `p=quarantine`, and later `p=reject`, once aggregate
  reports show your own mail passing alignment.
- `adkim=s` / `aspf=s` (strict) are correct for a single-sender domain and
  should be relaxed only if a legitimate sender fails alignment.

## 5. Syntactic validation

The proposed records were checked against RFC 7489 §6.3 tag grammar:
`v=` first and equal to `DMARC1`; `p=` second and one of
`none|quarantine|reject`; `rua=` a comma-separated list of `mailto:` URIs;
`fo=1` valid; `adkim`/`aspf` each `r` or `s`. The existing published record
`v=DMARC1; p=none; rua=mailto:dmarc@bookpitch.ge` is syntactically valid — its
defect is semantic (an unreachable destination), which no syntax check catches.

## 6. Classification

| Item | Launch blocker | Pilot blocker | Money required |
|---|---|---|---|
| Sending domain not verified (DKIM/SPF) | **Yes** | **Yes** | No |
| `_dmarc.bookpitch.ge` absent | **Yes** | No | No |
| `rua` destination unreachable | No — hardening | No | No, if using an owned mailbox |
| Subdomain `p=none` | No — hardening | No | No |

Verification email delivery is the first thing every new organisation depends
on. Until 3a is done, self-service signup cannot be relied upon in production.

## 7. What cannot be claimed

No message has been sent, received or inspected, so there is no
`Authentication-Results` evidence and no SPF, DKIM or DMARC pass has been
observed. No test mailbox has been designated. **DMARC readiness is not
claimed.** Proving it requires the human steps in
`docs/production-uat-checklist.md` §B against a designated mailbox.
