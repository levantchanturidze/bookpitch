# Email deliverability and domain readiness (Phase 15.5)

> **Authoritative UAT correction — 2026-09-15.** Production UAT has now received
> a Bookpitch reminder message in the designated synthetic mailbox and inspected
> its authentication headers. The recipient address is intentionally redacted
> from repository evidence. The received message passed SPF, DKIM and DMARC;
> DKIM aligned as **`d=send.bookpitch.ge`**. Any older checklist text expecting
> `d=bookpitch.ge`, or claiming that no real mailbox message has been inspected,
> is superseded by this section.

## 1. Sending identity

The production sending domain is **`send.bookpitch.ge`**, not the apex.

`RESEND_FROM` is configured as a Bookpitch sender under that domain. The exact
mailbox value is operational configuration and is not copied into documentation
or screenshots.

### DNS names

| Name | Type | Expected / observed purpose |
|---|---|---|
| `resend._domainkey.send.bookpitch.ge` | TXT | DKIM public key for the sending domain |
| `send.send.bookpitch.ge` | TXT | SPF: `v=spf1 include:amazonses.com ~all` |
| `send.send.bookpitch.ge` | MX | Resend / Amazon SES bounce handling |
| `_dmarc.send.bookpitch.ge` | TXT | DMARC policy for the sending subdomain |

The doubled `send.send.bookpitch.ge` label is intentional: Resend publishes SPF
and bounce MX on a `send.` child of the configured sending domain, which itself
is `send.bookpitch.ge`.

## 2. Production UAT delivery evidence

The 2026-09-15 production UAT reminder email was delivered to the designated
synthetic mailbox. Repository evidence must redact the recipient address and
message identifiers.

The inspected `Authentication-Results` established:

| Check | UAT result |
|---|---|
| SPF | **pass** |
| DKIM | **pass**, `d=send.bookpitch.ge` |
| DMARC | **pass** |
| Application reminder email | **delivered** |

This closes the former evidence gap where only provider-side acceptance had
been proven. It does **not** imply that every possible recipient provider will
place mail in the inbox rather than spam; it proves the production path and
alignment for the designated UAT mailbox.

## 3. Recipient evidence and redaction

The designated UAT mailbox is synthetic and operator-controlled, never a real
customer address. Its full address must not be committed to this repository.
When recording screenshots or raw headers:

- redact the recipient mailbox;
- redact `Message-ID` and provider-specific tracking identifiers;
- never record passwords, verification tokens, recovery codes or MFA secrets;
- preserve only the minimum fields needed to prove sender domain and SPF/DKIM/
  DMARC verdicts.

## 4. SMS production semantics

`SMS_PROVIDER=mock` has environment-dependent semantics and must not be treated
as an SMS delivery failure in production.

- **Production:** mock means SMS is intentionally **deferred / not shipped**.
  The reminder policy does not require SMS for release health, and a missing
  phone number or deferred provider must not create a provider-failure row that
  repeats on every scheduler tick.
- **Development / CI:** the mock adapter is executable and returns a provider
  message id, so tests may legitimately observe a sent result.

`lib/messaging/channel-policy.ts` is the authority for this distinction. Sender,
monitoring and deduplication must consume that same policy rather than each
hard-coding `sms` + `email` independently.

## 5. DMARC hardening remains separate

The production UAT authentication pass proves the current sending subdomain
aligns. Organisational-domain hardening may still be improved independently
(e.g. apex DMARC reporting/policy). Such hardening must not be confused with the
now-proven transactional delivery path.

Any future change from monitoring (`p=none`) toward enforcement
(`quarantine`/`reject`) should follow observed aggregate-report evidence and a
controlled rollout; it is an operator/DNS policy decision, not a prerequisite
for acknowledging the UAT pass above.

## 6. Current classification

| Item | Status |
|---|---|
| Sending domain | **`send.bookpitch.ge`** |
| SPF record | Present; production UAT **pass** |
| DKIM record | Present; production UAT **pass**, `d=send.bookpitch.ge` |
| DMARC | Production UAT **pass** |
| Real synthetic mailbox receipt | **Proven 2026-09-15; address redacted** |
| SMS mock in production | **Deferred by policy, not a delivery failure** |

This document supersedes earlier claims that no real mailbox receipt had been
inspected or that DKIM should align as `d=bookpitch.ge`.
