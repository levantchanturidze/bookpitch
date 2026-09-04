# Email deliverability and domain readiness (Phase 15.5)

> **Correction, 2026-08-19.** An earlier revision of this document reported the
> sending domain as unverified — no SPF, no DKIM, no bounce MX — and named that
> a launch blocker. **That was wrong.** It queried apex-based hostnames
> (`resend._domainkey.bookpitch.ge`, `bookpitch.ge`) after inferring the sender
> from an illustrative example in a code comment, instead of the sending domain
> actually configured. The real sending domain is **`send.bookpitch.ge`**, and
> its DKIM, SPF and bounce-MX records are all present and correct. The genuine
> gaps are narrower and are listed in §3.

## 1. Observed DNS state

Captured 2026-08-18T22:07:24Z against resolver `8.8.8.8`. Reproduce with
`dig @8.8.8.8 +short <TYPE> <NAME>`.

### Sending domain — `send.bookpitch.ge`

**Re-verified 2026-09-04** by direct `dig` against every name below; all four
records are present exactly as recorded.

A warning to the next reader, because it has now misled twice: querying
`send.bookpitch.ge` for SPF or MX returns NOTHING, and that is correct. Resend
publishes both on a `send.` CHILD of the sending domain, so the names are
`send.send.bookpitch.ge`. A check aimed at the obvious name concludes "no SPF,
no bounce MX" and is wrong — which is exactly the mistake §2 below documents
from Phase 13.

| Name | Type | Value | Verdict |
|---|---|---|---|
| `resend._domainkey.send.bookpitch.ge` | TXT | `p=MIGfMA0GCSqGSIb3DQEB…` (RSA public key) | **Present** |
| `send.send.bookpitch.ge` | TXT | `v=spf1 include:amazonses.com ~all` | **Present** |
| `send.send.bookpitch.ge` | MX | `10 feedback-smtp.eu-west-1.amazonses.com.` | **Present** |
| `_dmarc.send.bookpitch.ge` | TXT | `v=DMARC1; p=none; rua=mailto:dmarc@bookpitch.ge` | Present, `p=none` |

The doubled label in `send.send.bookpitch.ge` is not a typo: Resend publishes
SPF and the bounce MX on a `send.` child of the sending domain, and the sending
domain is itself `send.bookpitch.ge`.

### Apex — `bookpitch.ge`

| Name | Type | Value | Verdict |
|---|---|---|---|
| `bookpitch.ge` | A | `216.198.79.65`, `216.198.79.1` (Vercel) | Present |
| `bookpitch.ge` | NS | `ns1.vercel-dns.com.`, `ns2.vercel-dns.com.` | Present |
| `bookpitch.ge` | TXT | — | Absent (expected: apex does not send) |
| `bookpitch.ge` | MX | — | **Absent — see §3.2** |
| `_dmarc.bookpitch.ge` | TXT | — | **Absent — see §3.1** |
| `resend._domainkey.bookpitch.ge` | TXT | — | Absent (expected: wrong name) |

The apex is deliberately excluded from Resend; it is not a sending domain, so
the absence of SPF/DKIM there is correct rather than a defect.

## 2. Reconciliation with Phase 13

Both phases were looking at the same DNS. They disagreed because they asked
different questions.

| | Phase 13 | Phase 15 (first pass) | Truth |
|---|---|---|---|
| Sending domain | `send.bookpitch.ge` | assumed apex | `send.bookpitch.ge` |
| DKIM name queried | `resend._domainkey.send.bookpitch.ge` | `resend._domainkey.bookpitch.ge` | Phase 13 |
| SPF name queried | `send.send.bookpitch.ge` | `bookpitch.ge` | Phase 13 |
| Conclusion | verified | "not verified" | **verified** |

Phase 13 also recorded provider-level delivery evidence:
`RESEND_FROM = Bookpitch <no-reply@send.bookpitch.ge>`, and Resend reporting
`delivered@resend.dev → last_event: delivered` and
`bounced@resend.dev → last_event: bounced`. So the provider accepts mail from
this domain and the bounce path resolves.

Root cause of the error: the sender was inferred from
`RESEND_FROM — verified sender, e.g. "Bookpitch <no-reply@bookpitch.ge>"`, an
**illustrative comment** in `lib/messaging/email/resend.ts`, and the apex was
then queried as if it were the configured value. `RESEND_FROM` is a Vercel
environment variable whose value cannot be read back, so the configured domain
had to come from Phase 13's record — and it did not.

Lesson worth keeping: when a value cannot be read directly, take it from the
phase that measured it, not from an example in a comment.

## 3. Genuine remaining gaps

### 3.1 No organisational DMARC record — hardening

`_dmarc.bookpitch.ge` is absent. A subdomain policy exists at
`_dmarc.send.bookpitch.ge`, but receivers evaluating DMARC for
`send.bookpitch.ge` look up the subdomain record first and fall back to the
organisational domain's `sp=` only if there is none. With the subdomain record
present, mail from `send.bookpitch.ge` **is** covered by a published policy.

What the missing apex record costs: the apex itself publishes no policy, so it
is more attractive to spoof, and there is no single place to tighten policy
across all present and future subdomains.

Recommended:

| Name | Type | Value |
|---|---|---|
| `_dmarc` | TXT | `v=DMARC1; p=none; sp=none; rua=mailto:<reportable-mailbox>; fo=1; adkim=s; aspf=s` |

Start at `p=none`, observe a full reporting cycle, then tighten to
`quarantine` and `reject`. Phase 13 recommended going straight to
`p=reject; sp=reject`; that is the correct destination but not the correct
first step, because enforcing before reports confirm alignment risks rejecting
your own mail.

### 3.2 The DMARC reporting address cannot receive mail — hardening

`_dmarc.send.bookpitch.ge` publishes `rua=mailto:dmarc@bookpitch.ge`, and
`bookpitch.ge` has no MX record. Aggregate reports sent there bounce, so the
monitoring that `p=none` exists to provide yields nothing.

Options, cheapest first:

1. Point `rua` at a mailbox you already own on another domain. DMARC allows
   this, but the receiving domain must authorise it with
   `send.bookpitch.ge._report._dmarc.<their-domain> TXT "v=DMARC1"` — without
   that, conforming reporters refuse to send.
2. Add MX for `bookpitch.ge` at a real mail provider and keep the current
   address.
3. A hosted DMARC reporting service (several have free tiers; enabling a paid
   one is out of scope).

Leaving `rua` pointing at an unreachable address is worse than omitting it — it
looks like monitoring while delivering nothing.

### 3.3 No message has been received and inspected — external

Phase 13 proved provider-level acceptance and delivery to Resend's own test
addresses. Nothing has proved **inbox placement** or shown real
`Authentication-Results` headers, because no test mailbox has been designated.
The production monitor confirms nothing has been sent from the live system
either: outbox `pending=0`, `dead=0`, and no audit digest has ever been queued.

This is the one email item that genuinely blocks launch verification, and it
needs a human with a mailbox — see `docs/production-uat-checklist.md` §B.

## 4. Rollout and TTL

- Vercel DNS serves a 60-second TTL, so changes propagate in minutes. Confirm
  with `dig @8.8.8.8 +short TXT _dmarc.bookpitch.ge`, not a browser.
- DKIM and SPF are already published, so DMARC can be added without the usual
  "authenticate before you enforce" sequencing risk — provided it starts at
  `p=none`.
- `adkim=s` / `aspf=s` (strict) suit a single-sender domain. Relax only if a
  legitimate sender fails alignment.

## 5. Syntactic validation

Checked against RFC 7489 §6.3 tag grammar: `v=` first and equal to `DMARC1`;
`p=` second and one of `none|quarantine|reject`; `rua=` a comma-separated list
of `mailto:` URIs; `fo=1` valid; `adkim`/`aspf` each `r` or `s`; `sp=` valid
where present. The published `_dmarc.send.bookpitch.ge` record is
syntactically valid — its defect is semantic (an unreachable destination),
which no syntax check catches.

## 6. Classification

| Item | Status | Launch blocker | Pilot blocker | Money |
|---|---|---|---|---|
| Sending domain verified (DKIM/SPF/bounce MX) | **Present** | No | No | No |
| Provider accepts and delivers | **Proven (Phase 13)** | No | No | No |
| `_dmarc.bookpitch.ge` absent | Gap | No — hardening | No | No |
| `rua` destination unreachable | Gap | No — hardening | No | No, if using an owned mailbox |
| Real inbox receipt + headers inspected | **Never done** | **Yes** | **Yes** | No |

## 7. What cannot be claimed

No message has been received in a real mailbox and no `Authentication-Results`
header has been inspected, so **SPF, DKIM and DMARC pass verdicts are not
claimed**, and DMARC readiness is not claimed. The records being present in DNS
is necessary, not sufficient.
