# Privacy decisions for the owner and the legal reviewer

**Dated 2026-10-31.** Each item below is something the code does today that
no written requirement settles. None has been changed. An engineer must not
pick an answer: each is a statement about what Bookpitch does with a person's
data, and it is the owner's to make on the legal reviewer's advice.

Where an item ends in a code change, the change is small and the place is
named. Where it ends in a sentence for `/privacy`, the sentence is the
reviewer's to approve (`docs/legal-review-checklist.md`).

Requirements already written, and what this document does not reopen:
- `/privacy` (draft-2, #126) says redaction clears name, email and telephone,
  and lists what survives.
- #126 makes erasure remove waitlist entries, clear delivery records, copy the
  name nowhere, and refuse new waitlist entries and bookings for a redacted
  customer.
- #126 also covers public booking: a booking racing an erasure attaches to a
  new customer, not the redacted one (2026-10-31, `e9baeb5`).

## DEF-10: the customer's name goes to the payment gateway

| | |
|---|---|
| **Code path** | `lib/payments/service.ts` `startCardCheckout` builds `appointmentSummary: "<service name> · <customer name>"`. TBC (`lib/payments/gateways/tbc.ts`, first 100 characters) and BOG (`lib/payments/gateways/bog.ts`) send it as the order **description** |
| **Data** | The customer's full name and the service booked, held by the gateway, and possibly shown on statements and in the merchant's gateway portal |
| **Risk** | For a clinic, the service name can itself be health information ("Psychotherapy session · <name>"). That is special-category data sent to a processor that does not need it to take the payment. The gateway already holds the cardholder's own name, which is not the same thing |
| **Written requirement** | None says what the description must contain |
| **Options** | **A.** Neutral text: `"Appointment <short id>"`. The clinic still reconciles through the payment row, which carries the appointment id. **B.** The service name only, no person. **C.** Keep it, and name the gateways in `/privacy` as receiving name and service |
| **Consequences** | A removes the disclosure. Staff reconciling in the gateway portal see an id, not a name. B still discloses health information. C needs the reviewer to accept the disclosure and the sub-processor wording |
| **Recommendation** | **A.** It is one line in `startCardCheckout`, testable by asserting the description each gateway receives |

## DEF-11: public booking joins an existing record, and stamps consent, on an unverified address

| | |
|---|---|
| **Code path** | `lib/public-booking.ts` `submitPublicBooking` matches a returning customer on (organisation, email) or (organisation, phone) exactly as typed into the anonymous widget. It books for that record, and if the record has no consent, stamps `consentAt` / `consentVersion` on it |
| **Data** | A new appointment, with the form's free-text notes, on the matched person's record. Their record's consent fields |
| **Risk** | Anyone who knows a person's email address or phone number can add an appointment, and notes, to that person's record. The appointment's reminders then go to that person. Consent is recorded as given by the data subject when a third party may have ticked the box. The widget returns nothing about the record, so this is not a disclosure; it is integrity of the record and of the consent |
| **Written requirement** | The module header says consent is "REQUIRED on the payload and stamped onto the Customer row". It says nothing about whose consent it is |
| **Options** | **A.** Never attach: every public booking creates its own customer, and staff merge duplicates. **B.** Attach, but never stamp consent on an existing record; record the widget's consent against the new appointment instead. **C.** Verify before attaching: a one-time code to the matched email or phone. **D.** Keep it |
| **Consequences** | A means duplicate records and a merge workflow that does not exist yet. B is small, and fixes the consent record but not the misattached booking. C fixes both, but needs a verification flow and adds friction to booking. D leaves both risks and needs `/privacy` to say how consent is captured |
| **Recommendation** | **B now and C later**, or A if duplicates are acceptable. This is the item the legal reviewer should look at first: consent is a lawful-basis question |

## DEF-12: notifications copy names, and unread ones are kept for ever

| | |
|---|---|
| **Code path** | `lib/notifications.ts` `notifyEvent` stores `title` and `body` as text. Callers put the customer's name into them: a new booking, a status change (`components/scheduler/actions.ts`), and a reminder sent (`lib/messaging/reminders.ts`). `lib/housekeeping.ts` deletes **read** notifications after 30 days; unread ones are never deleted. A notification has no link to the customer it mentions |
| **Data** | Customer names, with service, staff and time, in the staff bell |
| **Risk** | An erasure cannot find these: there is no customer id to search by. So an erased person's name survives in every unread notification about them, indefinitely. `/privacy` draft-2 discloses this, but disclosing it does not remove it |
| **Written requirement** | None for notification retention. #126 already stopped the erasure's own notification copying the name |
| **Options** | **A.** Stop copying names: store the customer id, and render the name when the bell is read, so an erasure redacts it everywhere at once. **B.** Delete all notifications after N days whether read or not. **C.** Store the customer id beside the text, and have erasure delete or clear that customer's notifications. **D.** Keep it, and disclose it |
| **Consequences** | A is the complete fix, but every caller changes, and old rows still hold names (pair it with B once). B bounds the exposure but loses unread history. C fixes it for erasure only. D needs the reviewer's acceptance |
| **Recommendation** | **A, plus B once** (for example 90 days, if the owner accepts losing old unread notifications) to clear the rows written before A |

## DEF-13: appointment notes survive erasure

| | |
|---|---|
| **Code path** | `lib/gdpr.ts` `anonymizeCustomer` and `runRetentionTick` clear the customer's own columns, waitlist entries and delivery records (#126). They leave `appointments.notes`, `icd10_code` and `icd10_description` in place, and `treatment_history` (P15-005) |
| **Data** | Free text staff typed about the visit, and diagnosis codes. Health data |
| **Risk** | The redacted record no longer names the person. The notes may name them, or identify them in context, and stay linked to the redacted row |
| **Written requirement** | None. `/privacy` draft-2 lists appointment notes and treatment history as surviving |
| **The legal question** | Whether a medical-record retention duty (Georgian healthcare and patient-rights rules) requires keeping clinical notes for a period, and so limits erasure for clinics, while salons have no such duty |
| **Options** | **A.** Clear notes and diagnosis fields on erasure, for every vertical. **B.** Keep them for clinics while a retention duty applies, clear them for salons, and say so in `/privacy`. **C.** Keep them everywhere, and disclose |
| **Consequences** | A may breach a retention duty for clinics. B needs the duty's length and a vertical-aware erasure. C needs the reviewer to accept that erasure is partial |
| **Recommendation** | The legal reviewer decides the duty. Engineering can then implement A or B in `lib/gdpr.ts` with the same tests as #126 |

## DEF-45: staff can still write to a redacted customer

Found 2026-10-31. #126 refuses new **waitlist entries and bookings** for a
redacted customer. Two other writes are not refused:

| | |
|---|---|
| **Code path** | Treatment history: `POST /api/customers/[id]/history` and `addTreatmentHistoryAction` (`components/patients/actions.ts`). Customer edits: `PATCH /api/customers/[id]` and `updateCustomerAction` |
| **Data** | New clinical notes about the erased person; or their name, email or phone typed back into the redacted row |
| **Risk** | An edit that puts a name back makes the row look live again (`isRedactedCustomerName` no longer matches), so bookings are allowed again: the erasure is undone. New treatment history adds health data to a record whose subject asked to be erased |
| **Written requirement** | #126's principle, "a redacted customer gets no new waitlist entry or appointment: its notes would be new personal data about a person whose record was erased", covers these by analogy but does not name them |
| **Options** | **A.** Refuse both, with the same lock #126 uses (`lockCustomerForNewRecords`). **B.** Refuse edits to the redacted row, but allow treatment history, if clinics must document care already given (ties to DEF-13's retention duty). **C.** Keep both |
| **Consequences** | A is consistent with #126, but may block a clinic's documentation duty. B keeps that duty and closes the un-erasure path. C leaves the un-erasure path open |
| **Recommendation** | **B**, unless the legal reviewer finds no documentation duty, in which case A. Either is a small change beside #126's |

## Also for the owner, not privacy

- **Reminders for suspended or archived organisations.** The reminders cron
  messages customers of every organisation, in any status. Options and
  consequences are in #129's description.
- **F-5:** waitlist notifications from scheduler cancellations. Implemented in
  #130, which is a behaviour change for the owner to accept.
- **F-7:** lead times under 10 hours (`docs/post-release-backlog.md` §11).
- **DEF-08:** naming the organisation in every query, as a scheduled sweep
  (`docs/tenant-isolation-audit.md` §7).
