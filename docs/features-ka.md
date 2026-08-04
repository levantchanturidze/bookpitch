# Bookpitch — ფუნქციონალის ინვენტარი (ქართული)

რას აკეთებს Bookpitch დღეს, კოდში ფესვგადგმულად. თითოეული ჩანაწერი მიუთითებს
route handler-ზე, server action-ზე, service-ზე, cron-ზე, webhook-ზე, ბაზის
trigger-ზე ან UI გვერდზე. როლები არის RBAC როლის გასაღებები `prisma/rbac-seed.ts`-იდან;
სფერო ასახავს გრანტის კვალიფიკატორს (`:own`, `:branch`, `:org` ან `platform`).

შედგენილია 2026-08-05, `main` ბრენჩიდან.

## ვიზიტები (ჯავშნები)

| ფუნქცია | ფაილი | როლები | სფერო |
|---|---|---|---|
| აქტიური ლოკაციის თვის ვიზიტების ჩვენება (გრაფიკის სერვერზე რენდერი) | `app/(app)/scheduler/page.tsx` | `booking.read` მქონე ნებისმიერი | გრანტის მიხედვით: `own`/`branch`/`org` |
| ვიზიტების სია JSON API-ს გავლით (ფილტრი `locationId`, `from/to`) | `app/api/appointments/route.ts` GET | იგივე | იგივე; `:own`-ის მქონენი იფილტრება `staff.userId = მოთხოვნის ავტორი`-ს მიხედვით |
| ვიზიტის შექმნა (ორმაგი ჯავშნის აღკვეთით ბაზაში) | `app/api/appointments/route.ts` POST + `components/scheduler/actions.ts::bookAppointmentAction` | `booking.create` | ორგანიზაციის ნებისმიერი წევრი შესაბამისი უფლებით |
| ვიზიტის ცვლილება (გადადება / პერსონალის შეცვლა / სერვისის შეცვლა / შენიშვნები / ICD-10) | `app/api/appointments/[id]/route.ts` PATCH + `components/scheduler/actions.ts::updateAppointmentAction` | `booking.update` — `:own`-ისთვის რესურსზე მიბმული `ownerUserId` მოწმდება | კონტროლდება `resolveBookingOwner`-ით (`lib/rbac/scope.ts`) |
| ვიზიტის გაუქმება (სტატუსის ცვლილება; ათავისუფლებს დროის სლოტს) | იგივე PATCH `{status:'cancelled'}`-ით | იგივე | იგივე |
| გაუქმებისას მოცდის სიის ავტოინფორმირება | `lib/waitlist.ts::notifyWaitlistForCancelled` (გამოძახებული ვიზიტის PATCH ტრანზაქციაში) | სისტემა — გაუქმებაზე რეაქცია | ორგანიზაციულად შემოსაზღვრული |
| AI-ს დახმარებით ვიზიტის ჩანაწერის მონახაზი (Gemini) | `app/api/assistant/draft/route.ts` POST + `components/scheduler/actions.ts::draftAppointmentAction` | `client.read:contact` | ორგანიზაცია; თვიური ლიმიტი `ASSISTANT_MONTHLY_CAP_PER_ORG` |
| მოცდის სიაში კლიენტის დამატება | `app/api/waitlist/route.ts` POST + `lib/waitlist.ts::addToWaitlist` | `booking.create` | ორგანიზაცია |
| მოცდის სიის ჩვენება (`:own` / `:branch` სფეროთი ფილტრირებული) | `app/api/waitlist/route.ts` GET + `app/(app)/waitlist/page.tsx` | `booking.read` | პირადი პერსონალის ID-ები ან ფილიალის ლოკაციები |
| მოცდის ჩანაწერის ამოშლა | `app/api/waitlist/[id]/route.ts` DELETE | `booking.update` — `resolveWaitlistOwner` მოწმებით | იგივე |
| ორმაგი ჯავშნის აღკვეთა ბაზის დონეზე | `prisma/migrations/20260721220810_init/migration.sql` — `EXCLUDE USING gist (staff_id, tstzrange(starts_at, ends_at))` | Postgres კონსტრეინტი | გამორიცხავს გაუქმებულ ჩანაწერებს |
| პერსონალის ხელმისაწვდომობის შემოწმება ჯავშნის დროს | `lib/appointments.ts::assertWithinAvailability` (გამოიძახება create + update ორივე გზაზე) | ნებისმიერი ჩამწერი | `staff_availability` ჩანაწერების ჩარჩოში |

## საჯარო ჯავშნის ვიჯეტი

| ფუნქცია | ფაილი | როლები | სფერო |
|---|---|---|---|
| ლოკაციის საჯარო ჯავშნის გვერდის რენდერი (პერსონალის + სერვისის სია, სლოტის ამრჩევი) | `app/book/[slug]/page.tsx` + `lib/public-booking.ts::getPublicLocation` | ანონიმური | `Location.publicSlug`-ის მიხედვით |
| ანონიმური ჯავშნის გაგზავნა | `app/api/public/book/route.ts` POST + `lib/public-booking.ts::submitPublicBooking` | ანონიმური | 30 ჯავშანი/წუთი თითოეული ორგანიზაციისთვის |
| არსებული კლიენტის ხელახლა გამოყენება (ორგანიზაცია, email) ან (ორგანიზაცია, ტელეფონი)-ს მიხედვით | იგივე | სისტემა | ორგანიზაციებს შორის იდენტობა არასოდეს ერევა |
| `source: 'public_widget'` აუდიტის ჩანაწერის დაწერა | `lib/public-booking.ts:171` | სისტემა | Actor null |

## კლიენტები (პაციენტები)

| ფუნქცია | ფაილი | როლები | სფერო |
|---|---|---|---|
| ყველა კლიენტის ჩვენება (მგრძნობიარე ველების გაშიფვრით რენდერის დროს) | `app/(app)/patients/page.tsx` | `client.read:contact` | ორგანიზაცია |
| კლიენტების სია JSON API-ს გავლით | `app/api/customers/route.ts` GET | იგივე | ორგანიზაცია |
| კლიენტის შექმნა (`allergies` / `clinicalNotes` ველების დაშიფვრით) | `app/api/customers/route.ts` POST + `components/patients/actions.ts::createCustomerAction` | `client.create` | ორგანიზაცია |
| კლიენტის განახლება | `app/api/customers/[id]/route.ts` PATCH + `updateCustomerAction` | `client.read:contact` | ორგანიზაცია (RLS `withOrg`-ის გავლით) |
| ერთი კლიენტის მონაცემების ჩვენება (გაშიფრული) | `app/api/customers/[id]/route.ts` GET | `client.read:contact` | ორგანიზაცია |
| კლიენტის წაშლა (თუ არსებული ვიზიტებია, 409 შეცდომა) | `app/api/customers/[id]/route.ts` DELETE + `deleteCustomerAction` | `client.merge` | ორგანიზაცია |
| მკურნალობის ისტორიის ჩანაწერის დამატება | `app/api/customers/[id]/history/route.ts` POST + `addTreatmentHistoryAction` | `client.read:full` | ორგანიზაცია |
| ერთი კლიენტის სრული ჩანაწერის ექსპორტი JSON ფაილად | `app/api/customers/[id]/export/route.ts` POST + `lib/gdpr.ts::exportCustomerData` + `exportCustomerAction` | `client.export` | ორგანიზაცია; აუდიტში `{export:true}` |
| კლიენტის ანონიმიზაცია (PII-ს დამახსოვრება, FK მთლიანობის შენარჩუნებით) | `app/api/customers/[id]/anonymize/route.ts` POST + `lib/gdpr.ts::anonymizeCustomer` + `anonymizeCustomerAction` | `client.export` | ორგანიზაცია; body: `{reason:'gdpr'|'retention'|'admin'}` |
| ალერგიების + კლინიკური ჩანაწერების ბაზაში დაშიფვრა (AES-256-GCM) | `lib/crypto.ts` — `FIELD_ENCRYPTION_KEY`-ის გავლით | სისტემა | თითოეული სტრიქონისთვის |

## პერსონალი და წევრები

| ფუნქცია | ფაილი | როლები | სფერო |
|---|---|---|---|
| ორგანიზაციის პერსონალის სია | `app/api/admin/staff/route.ts` GET + `app/(app)/settings/staff/page.tsx` | `staff.update` | ორგანიზაცია |
| პერსონალის ჩანაწერის შექმნა | `app/api/admin/staff/route.ts` POST + `createStaffAction` | `staff.update` | ორგანიზაცია |
| პერსონალის ჩანაწერის განახლება | `app/api/admin/staff/[id]/route.ts` PATCH + `updateStaffAction` | `staff.update` | ორგანიზაცია |
| პერსონალის წაშლა (თუ არსებული ვიზიტებია, 409 შეცდომა) | `app/api/admin/staff/[id]/route.ts` DELETE + `deleteStaffAction` | `staff.deactivate` | ორგანიზაცია |
| პერსონალის კვირეული ხელმისაწვდომობის დაყენება | `app/api/admin/staff/[id]/availability/route.ts` PUT + `setAvailabilityAction` + `lib/admin.ts::setAvailability` | `staff.schedule.manage` (მიბმული მომხმარებლის owner-check-ით) | `own` — მიბმული მომხმარებელს, თუ არა `org` |
| ორგანიზაციის წევრების სია (ლოგინის მქონე ხალხი) | `app/api/admin/members/route.ts` GET + `app/(app)/settings/members/page.tsx` | `staff.invite` | ორგანიზაცია |
| წევრის მოწვევა (invitation ჩანაწერი + სურვილისამებრ email) | `lib/invitations.ts::createInvitation` + `inviteMemberAction` | `staff.invite` + rank check (`canManageRoleAssignment`) | ორგანიზაცია |
| მოწვევების სია / გაგზავნა / გაუქმება | `app/api/invitations/route.ts` GET/POST + `app/api/invitations/[id]/route.ts` DELETE | `staff.invite` | ორგანიზაცია |
| მოწვევის მიღება (ქმნის მომხმარებელს ან აქცევს არსებულს) | `app/api/invitations/accept/route.ts` POST + `lib/invitations.ts::acceptInvitation` | ანონიმური, ვალიდური ტოკენით | ორგანიზაცია |
| წევრის როლის შეცვლა | `app/api/admin/members/[id]/route.ts` PATCH + `updateMemberRoleAction` | `staff.role.assign` + rank guardrails (ბოლო-მფლობელი, უფრო მაღალი რანგის უარყოფა) | ორგანიზაცია |
| წევრის ამოშლა | `app/api/admin/members/[id]/route.ts` DELETE + `removeMemberAction` | `staff.deactivate` + rank + ბოლო-მფლობელის დაცვა | ორგანიზაცია |
| მფლობელობის გადაცემა სხვა წევრზე (ნომინირება) | `app/api/admin/ownership-transfer/route.ts` POST + `lib/admin/ownership-transfer.ts::nominateTransfer` | `org.ownership.transfer` | ორგანიზაცია |
| ნომინირებული პიროვნების მოლოდინის სია | `app/api/admin/ownership-transfer/route.ts` GET | სესიის მომხმარებელი | პირადი inbox |
| მფლობელობის გადაცემის მიღება (როლების ატომური გაცვლა + სესიების განულება) | `app/api/admin/ownership-transfer/[id]/accept/route.ts` POST | მხოლოდ ნომინირებული (WHERE-clause-ით გამყარებული) | ჯვარედინი ორგანიზაცია თავისი ბუნებით |
| მფლობელობის გადაცემის უარყოფა | `app/api/admin/ownership-transfer/[id]/decline/route.ts` POST | მხოლოდ ნომინირებული | იგივე |
| მოლოდინში მყოფი ნომინაციის გაუქმება | `app/api/admin/ownership-transfer/[id]/route.ts` DELETE | მხოლოდ ნომინატორი | იგივე |
| ბოლო-ORG_OWNER დაცვა (spec §9 rule 1) | `lib/admin/last-owner.ts::assertNotLastOwner` | Guard | გამოძახებული `updateMemberRole`, `removeMember`, `acceptTransfer`-იდან |

## სერვისები და ლოკაციები

| ფუნქცია | ფაილი | როლები | სფერო |
|---|---|---|---|
| სერვისების სია | `app/api/admin/services/route.ts` GET + `app/(app)/settings/services/page.tsx` | `service.manage` | ორგანიზაცია |
| სერვისის შექმნა | `app/api/admin/services/route.ts` POST + `createServiceAction` | `service.manage` | ორგანიზაცია |
| სერვისის განახლება | `app/api/admin/services/[id]/route.ts` PATCH + `updateServiceAction` | `service.manage` | ორგანიზაცია |
| სერვისის წაშლა | `app/api/admin/services/[id]/route.ts` DELETE + `deleteServiceAction` | `service.manage` | ორგანიზაცია |
| ლოკაციების სია | `app/api/admin/locations/route.ts` GET + `app/(app)/settings/locations/page.tsx` | `org.branch.manage` | ორგანიზაცია |
| ლოკაციის შექმნა | `app/api/admin/locations/route.ts` POST + `createLocationAction` | `org.branch.manage` | ორგანიზაცია |
| ლოკაციის განახლება (name/type/timezone/taxRate) | `app/api/admin/locations/[id]/route.ts` PATCH + `updateLocationAction` | `org.branch.manage` | ორგანიზაცია |
| ლოკაციის წაშლა (409 შეცდომა, თუ დამოკიდებულია სხვები) | `app/api/admin/locations/[id]/route.ts` DELETE + `deleteLocationAction` | `org.branch.manage` | ორგანიზაცია |
| აქტიური ლოკაციის შეცვლა (server-action cookie) | `components/shell/actions.ts::setActiveLocationAction` | სესიის მომხმარებელი | პირადი სესია |
| Location → Branch სინქრონიზაციის trigger (Phase 2 backfill) | `prisma/migrations/20260728000100_rbac_sync_triggers/migration.sql` — `locations_rbac_sync_{insert,update,delete}` | DB triggers | ავტომატური `branches` mirror |

## გადახდები

| ფუნქცია | ფაილი | როლები | სფერო |
|---|---|---|---|
| ბარათით გადახდის დაწყება (payment row + გადამისამართება gateway HPP-ზე) | `app/api/payments/checkout/route.ts` POST + `components/billing/actions.ts::startCardCheckoutAction` + `lib/payments/service.ts::startCardCheckout` | `payment.charge` | ორგანიზაცია |
| ნაღდი ფულით გადახდის ჩაწერა (ვიზიტი მაშინვე გადახდილად ინიშნება) | `app/api/payments/cash/route.ts` POST + `components/billing/actions.ts::settleCashAction` + `lib/payments/service.ts::settleCash` | `payment.charge` | ორგანიზაცია |
| გადახდის gateway-ის webhook (ბარათული გადახდის შედეგის მთავარი წყარო) | `app/api/webhooks/payment/route.ts` POST + `lib/payments/service.ts::applyWebhook` | ანონიმური (HMAC გადამოწმებული) | სისტემა |
| Webhook-ის ხელმოწერის გადამოწმება კონფიგურირებული gateway-ის მიხედვით | `lib/payments/gateway.ts::getGateway().verifyWebhook` | სისტემა | `PAYMENT_GATEWAY`-ით კონფიგურდება (მიმდინარეობით `mock`, გაფართოებადი) |
| Front-desk-ის ფასდაკლების ლიმიტის კონტროლი | `lib/payments/service.ts:244` კითხულობს `ctx.orgToggles.frontdeskDiscountCeiling`-ს | Runtime check | ორგანიზაციის ლიმიტს ზემოთ ფასდაკლებას უარყოფს |
| გადახდის შემდგომი გადამისამართების გვერდი | `app/(app)/billing/return/page.tsx` | `payment.charge` | აჩვენებს ბაზის მიმდინარე სტატუსს |
| Mock gateway-ის hosted-payment გვერდი (მხოლოდ dev-ში) | `app/dev/mock-gateway/pay/page.tsx` + `app/dev/mock-gateway/pay/actions.ts` (approve/decline actions) | ანონიმური; prod-ში დამალული `PAYMENT_GATEWAY=mock`-ის შემოწმებით | სისტემა |
| ბილინგის სია (ვიზიტები + უახლესი გადახდა) | `app/(app)/billing/page.tsx` | `payment.charge` | აქტიური ლოკაცია, ბოლო 30 დღე |

## გამოწერის ბილინგი (Stripe)

| ფუნქცია | ფაილი | როლები | სფერო |
|---|---|---|---|
| ამჟამინდელი გამოწერის ტარიფის + პერიოდის დასრულების ჩვენება | `app/(app)/settings/billing/page.tsx` + `lib/billing/service.ts::getBilling` | `org.billing.read` | ორგანიზაცია |
| Stripe Checkout Session-ის დაწყება ტარიფის შესაცვლელად | `app/api/billing/checkout/route.ts` POST + `lib/billing/service.ts::startCheckout` | `org.billing.manage` | ორგანიზაცია |
| Stripe webhook → subscription event → ორგანიზაციის ჩანაწერზე გამოყენება | `app/api/webhooks/stripe/route.ts` POST + `lib/billing/service.ts::applySubscriptionEvent` | ანონიმური (Stripe signature გადამოწმებული) | Org-ს იპოვის `stripe_customer_id`-ით ან metadata-ით |
| მხოლოდ-წაკითხვის billing პანელი platform OrgDetail-ზე (plan / status / period-end / Stripe deep-links) | `components/platform/OrgDetail.tsx::BillingPanel` | ნებისმიერი platform role `platform.analytics.read`-ის მქონე | Platform |

## რეპორტინგი და ანალიტიკა

| ფუნქცია | ფაილი | როლები | სფერო |
|---|---|---|---|
| ანალიტიკის გვერდი — შემოსავალი / რეიტინგი / ჩართულობა + დღიური roster | `app/(app)/analytics/page.tsx` + `lib/analytics.ts::computeMetrics`, `dailyRoster` | `report.branch` | აქტიური ლოკაცია |
| სადაზღვევო CSV ექსპორტი (დამთავრებული ICD-10 კოდიანი ვიზიტები დაზღვევის მქონე კლიენტებზე) | `app/api/insurance/export/route.ts` GET | `report.export` | ორგანიზაცია; ფილტრი დამზღვევის მიხედვით |
| დამზღვევების სია | `app/api/insurance/insurers/route.ts` GET + `app/(app)/settings/insurance/page.tsx` | `service.manage` | ორგანიზაცია |
| აუდიტის ჟურნალის მნახველი (მხოლოდ მფლობელი; filter — actor/customer/action/date) | `app/(app)/audit/page.tsx` + `lib/audit-query.ts::queryAudit` | `audit.read` | ორგანიზაცია; read replica-ს გავლით (`withOrgReplica`) |
| ყოველკვირეული აუდიტის digest email ორგანიზაციის მფლობელებზე | `app/api/cron/audit-digest/route.ts` POST + `lib/audit-digest.ts::runDigestForAllOrgs` | Cron (bearer `CRON_SECRET`) | ყველა ორგანიზაცია; ეგზავნება ყველა ORG_OWNER-ს |

## შეხსენებები და შეტყობინებები

| ფუნქცია | ფაილი | როლები | სფერო |
|---|---|---|---|
| ყველა დაგეგმილი ვიზიტისთვის შეხსენების გაგზავნა (cron) | `app/api/cron/reminders/route.ts` POST + `lib/messaging/reminders.ts::runReminderTick` | Bearer `CRON_SECRET`; ორგანიზაციაზე ცალკე გაშვება | ყველა ორგანიზაცია |
| კონკრეტული ვიზიტისთვის შეხსენების დაუყოვნებელი გაგზავნა | `app/api/reminders/send-now/route.ts` POST + `sendNowAction` + `lib/messaging/reminders.ts::sendNowForSession` | `booking.update` (per-resource `ownerUserId` check) | პირადი ვიზიტები ან უფრო ფართო |
| ორგანიზაციის შეხსენების lead-hours-ის კონფიგურაცია | `saveLeadHoursAction` + `organizations.reminderLeadHours` column | `org.settings.update:org` | ორგანიზაცია |
| ორგანიზაციისთვის SMS + email შაბლონების კონფიგურაცია | `saveTemplateAction` + `MessageTemplate` table | `org.settings.update:org` | ორგანიზაცია |
| შაბლონების რენდერი: `{PatientName}`, `{StaffName}`, `{ServiceName}`, `{Date}`, `{Time}` | `lib/messaging/templates.ts::renderTemplate` | სისტემა | გაგზავნის დროს |
| SMS SMS Office-ის (ქართული ოპერატორი) ან mock-ის გავლით | `lib/messaging/sms/smsoffice.ts`, `lib/messaging/sms/mock.ts` — არჩევა `SMS_PROVIDER` env-ით | სისტემა | სისტემა |
| Email Postmark-ის ან mock-ის გავლით | `lib/messaging/email/postmark.ts`, `lib/messaging/email/mock.ts` — არჩევა `EMAIL_PROVIDER` env-ით | სისტემა | სისტემა |
| Message-log ჩაწერა თითოეული ცდისთვის (queued/sent/failed) | `lib/messaging/reminders.ts:88, 107, 131, 159` | სისტემა | შეიცავს `toAddress` + რენდერილ `body`-ს |
| იდემპოტენტური (appointment, channel)-ის მიხედვით — თუ უკვე გაგზავნილია, გამოტოვება | `lib/messaging/reminders.ts::alreadyReminded` | სისტემა | `message_log` state-ის მიხედვით |

## აპლიკაციაში-შიდა შეტყობინებები

| ფუნქცია | ფაილი | როლები | სფერო |
|---|---|---|---|
| შეტყობინების ჩანაწერის შენახვა (ნებისმიერი კოდიდან) | `lib/notifications.ts::notifyEvent` | სისტემა | ორგანიზაცია |
| ზედა-ზარის (header bell) წაუკითხავი რაოდენობის pull (30 წამში ერთხელ) | კლიენტ-ჰუკი + `app/api/notifications/route.ts` GET | სესიის მომხმარებელი | პირადი ორგანიზაცია |
| ყველა წაკითხულად მონიშვნა | `app/api/notifications/mark-all-read/route.ts` POST | სესიის მომხმარებელი | პირადი ორგანიზაცია |
| ყველას გაწმენდა | `app/api/notifications/clear/route.ts` POST | სესიის მომხმარებელი | პირადი ორგანიზაცია |
| Web Push გამოწერის რეგისტრაცია | `app/api/push/subscribe/route.ts` POST + `lib/push.ts::saveSubscription` | სესიის მომხმარებელი | პირადი, ორგანიზაციათა შორის |
| Web Push-ის მოხსნა | `app/api/push/unsubscribe/route.ts` POST + `lib/push.ts::removeSubscription` | სესიის მომხმარებელი | იგივე |
| Web Push-ის გაგზავნა userId-ზე (მკვდარი გამოწერების გაწმენდით) | `lib/push.ts::pushToUser` | სისტემა | იყენებს VAPID გასაღებებს |
| შეტყობინება: შეხსენება გაიგზავნა (SMS/email) | `lib/messaging/reminders.ts:152` — `${customer.name} · ${serviceName}` body | სისტემა | ორგანიზაცია |
| შეტყობინება: გადახდა მიღებულია (ბარათი ან ნაღდი) | `lib/payments/service.ts:143, 211` | სისტემა | ორგანიზაცია |
| შეტყობინება: ახალი საჯარო ჯავშანი | `lib/public-booking.ts:181` | სისტემა | ორგანიზაცია |
| შეტყობინება: მოცდის სიის დამთხვევა გაუქმებაზე | `lib/waitlist.ts:150` | სისტემა | ორგანიზაცია |
| შეტყობინება: კლიენტი გახდა ანონიმური | `lib/gdpr.ts:184` — შეიცავს წინა სახელს | სისტემა | ორგანიზაცია |
| შეტყობინება: მიღებული მფლობელობის ნომინაცია | `lib/admin/ownership-transfer.ts:84` | სისტემა | სამიზნე ორგანიზაცია |
| შეტყობინება: platform-იმპერსონაცია დაიწყო თქვენს ორგანიზაციაზე | `lib/platform/impersonation.ts:118` | სისტემა | სამიზნე ორგანიზაცია |

## პერსონალურ მონაცემთა დაცვა (GDPR / საქართველოს DP კანონი)

| ფუნქცია | ფაილი | როლები | სფერო |
|---|---|---|---|
| Data-subject-request (DSR) აქტივობის პანელი SLA-ს საათით | `app/(app)/settings/privacy/page.tsx` + `lib/gdpr-queue.ts::recentDsrActivity` | `org.settings.update:org` | ორგანიზაცია |
| DSR-ს ვადა დღეებში (env-ით კონფიგურირებადი) | `DSR_DEADLINE_DAYS` env + `lib/gdpr-queue.ts::dsrDeadlineDays` | სისტემა | გლობალური |
| შენახვის სვეპი — `customerRetentionYears`-ის შემდეგ კლიენტების ანონიმიზაცია | `app/api/cron/retention/route.ts` POST + `lib/gdpr.ts::runRetentionTick` | Bearer `CRON_SECRET`; ღამით 02:17 UTC | ყველა ორგანიზაცია |
| ორგანიზაციისთვის შენახვის წლების კონფიგურაცია | `saveRetentionYearsAction` + `organizations.customerRetentionYears` | `org.settings.update:org` | ორგანიზაცია |
| შენახვის სვეპის ხელით გაშვება | `runRetentionTickAction` (რემინდერების გვერდის ღილაკი) | `org.settings.update:org` | პირადი ორგანიზაცია |
| `allergies` + `clinicalNotes` ველების დაშიფვრა ბაზაში (AES-256-GCM) | `lib/crypto.ts` — `FIELD_ENCRYPTION_KEY`-ის გავლით | სისტემა | თითოეული სტრიქონისთვის |
| აუდიტის კვალის შენარჩუნება ანონიმიზაციისას (აუდიტში `previousName` რჩება; მაქმანილი user-ის ჩანაწერი რჩება FK-ის მთლიანობისთვის) | `lib/gdpr.ts:180, 249` + audit_log FK არის `ON DELETE NO ACTION` | სისტემა | დოკუმენტირებული ვითარება SEC-007 addendum-ში |

## Platform ადმინისტრირება

| ფუნქცია | ფაილი | როლები | სფერო |
|---|---|---|---|
| ყველა ორგანიზაციის სია (სტატუსის სამომხმარებლო ხედი: count-by-status, უფლების არმქონე მფლობელი, ბოლო რეგისტრაცია) | `app/platform/orgs/page.tsx` + `components/platform/OrgList.tsx::StatusSummary` | `platform.analytics.read` | Platform |
| ახალი ორგანიზაციის შექმნა (სურვილისამებრ owner-ის მოწვევით) | `app/platform/orgs/new/page.tsx` + `app/api/platform/orgs/route.ts` POST + `lib/platform/orgs.ts::createOrganization` | `platform.org.create` | Platform |
| ორგანიზაციის დეტალები (owner / members / branches / counts / billing panel / toggles) | `app/platform/orgs/[id]/page.tsx` + `components/platform/OrgDetail.tsx` | `platform.analytics.read` | Platform |
| ორგანიზაციის ჩასწორება (name / vertical / allowSupportImpersonation) | `app/api/platform/orgs/[id]/route.ts` PATCH + `lib/platform/orgs.ts::editOrganization` | `platform.org.suspend` (გამოყენებული როგორც შესატყვისი დონე) + პაროლის ხელახალი დადასტურება იმპერსონაციის-ფლაგის შესაცვლელად | Platform |
| ორგანიზაციის შეჩერება | `app/api/platform/orgs/[id]/suspend/route.ts` POST + `lib/platform/orgs.ts::suspendOrganization` + `Btn` OrgDetail-ზე | `platform.org.suspend` + reauth | Platform |
| შეჩერებული ორგანიზაციის რეაქტივაცია | `app/api/platform/orgs/[id]/reactivate/route.ts` POST + `reactivateOrganization` | `platform.org.suspend` | Platform |
| ორგანიზაციის soft-delete (30-დღიანი grace) | `app/api/platform/orgs/[id]/soft-delete/route.ts` POST + `softDeleteOrganization` | `platform.org.delete` + reauth | Platform |
| ორგანიზაციის მფლობელის შეცვლა (არსებული წევრის დაწინაურება ან მოწვევა) | `app/api/platform/orgs/[id]/owner/route.ts` PATCH + `changeOrganizationOwner` | `platform.org.owner.change` | Platform |
| წევრზე პაროლის აღდგენის ბმულის გაგზავნა (არა-წევრზე ჩუმი წარმატება) | `app/api/platform/orgs/[id]/reset-password-link/route.ts` POST + `sendPasswordResetLink` | `platform.user.password_reset` | Platform |
| ორგანიზაციული ტოგლების ჩვენება | `app/api/platform/orgs/[id]/toggles/route.ts` GET + `lib/rbac/toggles.ts::loadOrgToggles` + `OrgTogglesPanel` OrgDetail-ზე | ნებისმიერი platform role `platform.analytics.read`-ის მქონე | Platform |
| ორგანიზაციული ტოგლების ჩასწორება (წერს `org.toggles.update` აუდიტს before/after-ით) | `app/api/platform/orgs/[id]/toggles/route.ts` PATCH + `updateOrgToggles` | `platform.config.manage` (მხოლოდ SUPER) + reauth | Platform |
| Platform როლების მფლობელების roster | `app/platform/roles/page.tsx` + `app/api/platform/roles/route.ts` GET + `listPlatformRoleHolders` | `platform.audit.read` | Platform |
| Platform როლის მინიჭება ან გაუქმება მომხმარებელზე | `app/api/platform/roles/route.ts` POST + `assignPlatformRole` | `platform.role.assign` (მხოლოდ SUPER) + ბოლო-SUPER_ADMIN-ის დაცვა | Platform |
| ორგანიზაციის წევრზე იმპერსონაცია (დიაგნოსტიკური; აუდიტირებული) | `app/api/platform/impersonate/route.ts` POST + `lib/platform/impersonation.ts::startImpersonation` | `platform.impersonate` + ორგანიზაციის `allow_support_impersonation` ფლაგი | ჯვარედინი |
| იმპერსონაციის სესიის დასრულება | `app/api/platform/impersonate/end/route.ts` POST + `endImpersonation` | სესიის ავტორი | პირადი სესია |
| RESTRICTED-DURING-IMPERSONATION-ის უფლებები ბლოკავს დესტრუქციულ/კლინიკურ/პოლიტიკის ცვლილებებს | `lib/rbac/impersonation.ts::RESTRICTED_DURING_IMPERSONATION` | RBAC gate | 16 კონკრეტული უფლება, მათ შორის `platform.config.manage` |
| Break-glass სესიის აქტივაცია (SUPER; აუდიტირებული; დროში შემოსაზღვრული) | `app/api/platform/break-glass/route.ts` POST + `lib/platform/break-glass.ts::startBreakGlass` | SUPER_ADMIN, პაროლის ხელახალი, ticketId აუცილებელი | ოფცია: სამიზნე ორგანიზაცია |
| Break-glass სესიის დასრულება | `app/api/platform/break-glass/end/route.ts` POST + `endBreakGlass` | სესიის ავტორი | პირადი სესია |
| Break-glass აქტივაციის ფორმა + მუდმივი წითელი ბანერი | `app/platform/break-glass/page.tsx` + `components/platform/BreakGlassForm.tsx` + `PlatformShell` banner | SUPER_ADMIN | Platform |
| break-glass სესიაში ყოველი წაკითხვა წერს აუდიტს (fail-closed, თუ ჩაწერა ვერ ხერხდება) | `lib/platform/api.ts::withPlatformApi` + `auditBreakGlassRead` | სისტემა | ავტო-აუდიტი |
| ჯვარედინი-ორგანიზაციული აუდიტის მნახველი, SUPPORT_AGENT-სთვის PII-ის მაქმანით | `app/platform/audit/page.tsx` + `app/api/platform/audit/route.ts` GET + `lib/platform/audit.ts::queryPlatformAudit` | `platform.audit.read` | Platform; SUPPORT-ს ხედავს დაფარულ PII-ს |
| პაროლის ხელახალი დადასტურების პრიმიტივი (60-წამიანი ფრეშნესის ფანჯარა, rate-limited) | `lib/platform/password-reauth.ts::verifyPasswordFresh` + `requireFreshPassword` + `POST /api/platform/reauth` | ავტორიზებული მომხმარებელი | per-user marker |

## Auth, სესია და ანგარიშები

| ფუნქცია | ფაილი | როლები | სფერო |
|---|---|---|---|
| Email + პაროლით sign-in (JWT sessions, Auth.js v5) | `app/(auth)/signin/page.tsx` + `app/(auth)/signin/actions.ts` + `auth.ts::authorize` + `lib/auth/credentials.ts::validateCredentials` | ანონიმური | გლობალური |
| თვითრეგისტრაცია — ორგანიზაციის შექმნა (user + org + owner membership + პირველი ლოკაცია ატომურად) | `app/(auth)/signup/page.tsx` + `app/api/onboard/route.ts` POST + `lib/onboarding.ts::onboardOrg` | ანონიმური | გლობალური |
| გამოსვლა | `components/shell/actions.ts::signOutAction` | სესიის მომხმარებელი | პირადი სესია |
| პაროლის აღდგენის მოთხოვნა (უცნობი email-ისთვის ჩუმი წარმატება) | `app/(auth)/reset/page.tsx` + `app/api/auth/reset/request/route.ts` POST + `lib/auth/password-reset.ts::requestPasswordReset` | ანონიმური | rate-limited |
| პაროლის აღდგენის ტოკენის გამოყენება (ახალი hash, sessionVersion ცვლილება) | `app/api/auth/reset/consume/route.ts` POST + `consumePasswordReset` | ანონიმური ვალიდური hash-იანი ტოკენით | გლობალური |
| მოწვევის მიღება (user-ის შექმნა ან დაწინაურება; ორგანიზაციული membership-ის დამატება) | `app/(auth)/invite/page.tsx` + `app/api/invitations/accept/route.ts` + `acceptInvitation` | ანონიმური ვალიდური ტოკენით | სამიზნე ორგანიზაცია |
| მომხმარებლის აქტიური membership-ების სია (multi-org picker feed) | `app/api/session/memberships/route.ts` GET + `lib/org-switch.ts::listUserMemberships` | სესიის მომხმარებელი | პირადი memberships |
| აქტიური ორგანიზაციის შეცვლა (sessionVersion++, სამიზნე orgId-ით სავალდებულო re-sign-in) | `app/api/session/switch/route.ts` POST + `switchActiveOrg` | სესიის მომხმარებელი | პირადი memberships |
| როლის-შესაბამისი დაფარვის გვერდი (SUPER→/platform, ACCOUNTANT→/analytics, MARKETING→/patients, სხვა /scheduler) | `app/page.tsx` | სესიის მომხმარებელი | პირადი როლი |
| სესიის განულება sessionVersion-ის გავლით — პაროლის ცვლილება, როლის ცვლილება, ownership transfer, org switch, platform-role assign | `auth.ts::session` callback + `lib/*::*sessionVersion: {increment: 1}*` writers | სისტემა | per-user; 5 წამის TTL |
| Argon2 პაროლის ჰეშირება | `@node-rs/argon2` — `credentials.ts`, `password-reset.ts`, `onboarding.ts`, `invitations.ts`-ში | სისტემა | გლობალური |
| Platform-plane უსაფრთხოების email SUPER/PLATFORM-ის sign-in-ზე | `auth.ts::alertOnPlatformLogin` → `SECURITY_ALERT_EMAIL` | სისტემა | Best-effort, არა-ბლოკავი |
| middleware-ს დონეზე ავტორიზაცის-არარსებობის გადამისამართება `/signin`-ზე | `proxy.ts` (Next 16 Node Proxy) | ყოველი მოთხოვნა | გამონაკლისი — public-path allowlist `auth.config.ts::isPublicPath`-ში |

## ორგანიზაციული პარამეტრები (owner-facing)

| ფუნქცია | ფაილი | როლები | სფერო |
|---|---|---|---|
| Settings-ის shell + tabs nav | `app/(app)/settings/layout.tsx` + `components/settings/TabsNav.tsx` | `org.settings.update:org` | ორგანიზაცია |
| უფლებების/ტოგლების პანელი (4 ორგანიზაციული ტოგლი) | `app/(app)/settings/permissions/page.tsx` + `components/settings/PermissionsPanel.tsx` + `app/api/admin/toggles/route.ts` GET/PATCH | `org.settings.update:org` | ორგანიზაცია |
| ტოგლი: provider financial reports | სვეტი: `organizations.features.providerFinancialReports` — კოდში არსად არ იკითხება (იხ. referenced-but-missing) | Owner აყენებს | ორგანიზაცია |
| ტოგლი: provider-ის წვდომა სხვა კლინიცისტების ჩანაწერებზე | `organizations.features.providerClinicalNotesOthers` — არსად არ იკითხება | Owner აყენებს | ორგანიზაცია |
| ტოგლი: front-desk-ის სრული კლიენტის ისტორია | `organizations.features.frontdeskClientFullHistory` — არსად არ იკითხება | Owner აყენებს | ორგანიზაცია |
| ტოგლი: front-desk-ის ფასდაკლების ლიმიტი (რიცხვი) | `organizations.features.frontdeskDiscountCeiling` — გამოიყენება `lib/payments/service.ts:244`-ში | Owner აყენებს | თითოეული გადახდისთვის |
| შეხსენებების კონფიგურაციის გვერდი | `app/(app)/reminders/page.tsx` | `booking.update`; template edit საჭიროებს `org.settings.update:org` | ორგანიზაცია |
| Privacy / DSR panel client-picker-ით (export / anonymize inline) | `app/(app)/settings/privacy/page.tsx` + `PrivacyView.tsx` | `org.settings.update:org` პანელისთვის; ცალკე მოქმედებებს ცალკე უფლება ჭირდება | ორგანიზაცია |
| ორგანიზაციისთვის allow-support-impersonation ტოგლი | `organizations.allowSupportImpersonation` სვეტი; ჩასწორდება platform-plane `editOrganization`-იდან | `platform.org.suspend` დონე | ორგანიზაცია |

## აუდიტის ჟურნალი (write-side)

| ფუნქცია | ფაილი | როლები | სფერო |
|---|---|---|---|
| აუდიტის ჩანაწერის დამატება (org-plane, caller-ის ტრანზაქციაში) | `lib/audit.ts::writeAudit` | სისტემა | თითოეული მოთხოვნისთვის |
| Platform-plane აუდიტის ჩაწერის ჰელპერი | `lib/platform/orgs.ts::writePlatformAudit` (private, per-org rows) | სისტემა | თითოეული platform action-ისთვის |
| Break-glass read აუდიტის ჩაწერა (fail-closed) | `lib/platform/break-glass.ts::auditBreakGlassRead` (გამოიძახება `withPlatformApi`-იდან, როცა `ctx.isBreakGlass`) | სისტემა | თითოეული break-glass request-ისთვის |
| ტოგლის ცვლილების აუდიტი სრული before/after-ით `meta`-ში | `app/api/platform/orgs/[id]/toggles/route.ts:64` (SEC-004 fix) | სისტემა | თითოეული toggle edit-ისთვის |
| თითოეული mutation წერს აუდიტს | 44 `writeAudit`/`auditLog.create` call sites `lib/`, `app/api/`-ში | სისტემა | თითოეული mutation-ისთვის |
| Append-only enforcement: `audit_log`-ზე BEFORE UPDATE / DELETE / TRUNCATE triggers (parent + ყოველი monthly partition) | `prisma/migrations/20260727170000_rbac_audit_log_append_only/migration.sql` + `20260727180000_audit_log_fk_hardening/migration.sql` | DB triggers | ვრცელდება ყოველ როლზე, ჩათვლით superuser-ის |
| REVOKE UPDATE, DELETE FROM bookpitch_app audit_log-ზე + ყოველ partition-ზე | იგივე მიგრაცია | GRANT-დონე | Runtime როლი ვერ ცვლის |
| ყოველთვიური partition rollover — მომდევნო 3 თვის წინასწარი შექმნა | `app/api/cron/db-partitions/route.ts` POST + `bp_create_monthly_partition()` SQL ფუნქცია | Cron | Bearer `CRON_SECRET`, ყოველ თვე 01:30 UTC |
| audit_log-ის FK `organization_id` / `actor_user_id`-ზე = `ON DELETE NO ACTION` | `prisma/migrations/20260727180000_audit_log_fk_hardening/migration.sql` | Constraint | აიძულებს soft-mask-ს წაშლისას |

## სისტემა, ინფრასტრუქტურა და ჯანმრთელობა

| ფუნქცია | ფაილი | როლები | სფერო |
|---|---|---|---|
| DB კავშირის per-client health probe (სამი კლიენტი: app, superuser, narrow-login) | `app/api/health/route.ts` GET | ანონიმური | ავრიალებს env-var-ის სახელით; URL-ს არ ავრიალებს |
| Uptime + latency logging request-id-ით | `lib/logger.ts` + `lib/auth.ts::withApi` | სისტემა | ყოველი მოთხოვნისთვის |
| სტრუქტურირებული PII scrubbing emit-ის დროს (SEC-007 followup) | `lib/logger.ts::scrubPhi` — 20 ზუსტი PII/secret გასაღები redacted | სისტემა | ყოველი log line-ისთვის |
| Sentry hook stub (მზადაა SDK-ის დამატებაზე) | `lib/logger.ts::sentryBeforeSend` | სისტემა | ამატებს orgId + requestId tags |
| Auth.js JWT + PrismaAdapter | `auth.ts` | სისტემა | Session-only DB writes `unsafePrismaAdmin`-ის გავლით |
| სამი Postgres როლი DB-ს დონეზე: `bookpitch_app` (NOBYPASSRLS runtime), `bookpitch_login` (BYPASSRLS narrow-grant auth), `postgres` (superuser) | `lib/db.ts` — `prismaApp`, `prismaLogin`, `unsafePrismaAdmin` | Runtime | Env: `DATABASE_URL`, `DATABASE_URL_LOGIN`, `DATABASE_URL_SUPERUSER_TXPOOL` |
| ESLint restrict-imports `unsafePrismaAdmin` / `withoutRls` / `prismaLogin`-ზე allowlist-ით | `eslint.config.mjs` — `UNSAFE_DB_ALLOWLIST` | Build-time gate | ყოველი runtime source file |
| სერვერული guard-check სკრიპტი (ყოველ route.ts-ს აქვს `requireAuthContext` თუ allowlist-ში არაა) | `scripts/check-guards.ts` (`npm run test:guards`) | Build-time gate | ყოველი route.ts + page.tsx |
| RBAC enforcement per module `RBAC_ENFORCE_MODULES` env-ის მიხედვით | `lib/rbac/guard.ts::isEnforcing` + `requirePermission` | Runtime | ამჟამად `*` (ყოველი module) prod-ში |
| RLS tenant-isolation policy 16 ცხრილზე (organizations, memberships, locations, staff, services, customers, appointments, payments, message_templates, message_log, notifications, staff_availability, treatment_history, audit_log, waitlist, invitations, branches, membership_branches, ownership_transfers, rate_limit, assistant_usage) | `prisma/migrations/20260722000002_add_rls/migration.sql` + შემდგომი მიგრაციები | Postgres `USING (organization_id = current_org_id())` | ყოველი query `prismaApp`-ზე |
| RLS FORCE ყოველ tenant-ცხრილზე (თუნდაც DB owner-ს ეხება) | იგივე | Postgres | ყოველი tenant table |
| `SET LOCAL app.current_org_id` ყოველ `withOrg` ტრანზაქციაში | `lib/db.ts::withOrg` | სისტემა | თითოეული მოთხოვნისთვის |
| Read replica routing (`prismaReplica`) ანალიტიკისთვის + audit viewer-ისთვის | `lib/db.ts::withOrgReplica` + `DATABASE_URL_APP_REPLICA` env | სისტემა | სურვილისამებრ, პრიმარიზე ბრუნდება |
| PG connection-pool cap per client (`PG_POOL_MAX`, default 3) | `lib/db.ts::POOL_MAX` | სისტემა | თითოეული Prisma client-ისთვის |
| `unsafePrismaAdmin`-ისთვის transaction-pool routing | `DATABASE_URL_SUPERUSER_TXPOOL` (SEC-007) | სისტემა | session-pool-ის დატვირთვას აშორებს |
| Rate-limit primitives (per-org, per-key) | `lib/rate-limit.ts` — გამოიყენება public-book, messaging, assistant-ის მიერ | სისტემა | DB-backed table |
| Session-version cache invalidation | `auth.ts::__clearSessionVersionCache` + `lib/auth/*::getCurrentSessionVersion` | სისტემა | 5 წამის TTL |
| Field-encryption გასაღების როტაცია არაა ავტომატიზირებული | `FIELD_ENCRYPTION_KEY` — ერთი გასაღები, გარე როტაციის სკრიპტი | სისტემა | Manual |
| Migration deploy workflow auto-issue-ით failure-ზე (assignee = repo owner) | `.github/workflows/migrate.yml` | GH Actions | prisma/migrations/**-ზე push-ზე ან manual dispatch-ზე |
| Cron workflows ეშვება ყოველ 15წ (reminders), საათში (housekeeping), ღამით 02:17 UTC (retention), ორშაბათს 08:00 UTC (audit-digest), თვის 1-ს 01:30 UTC (db-partitions) | `.github/workflows/cron.yml` | GH Actions | თითოეული POST bearer `CRON_SECRET`-ით |
| Housekeeping cron — expires impersonation/break-glass sessions `expires_at`-ის შემდეგ; sweeps stale rate-limit rows | `app/api/cron/housekeeping/route.ts` + `lib/housekeeping.ts::runHousekeeping` | Cron | საათში |
| Offline PWA shell გვერდი | `app/offline/page.tsx` | ანონიმური | Service worker fallback |
| Web Push VAPID setup + payload send | `lib/push.ts::ensureVapid` — `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` env | სისტემა | per-user |

## AI ასისტენტი

| ფუნქცია | ფაილი | როლები | სფერო |
|---|---|---|---|
| ვიზიტის / ჩანაწერის ტექსტის მონახაზი Gemini-ს გავლით | `app/api/assistant/draft/route.ts` POST + `lib/assistant/*.ts` | `client.read:contact` | ორგანიზაცია |
| ორგანიზაციისთვის თვიური ლიმიტი ასისტენტის ზარებზე | `ASSISTANT_MONTHLY_CAP_PER_ORG` env + `lib/assistant/quota.ts` + `assistant_usage` table | Runtime cap | ორგანიზაციულად შემოსაზღვრული |
| მოდელის არჩევა env-ით | `ASSISTANT_MODEL` env | სისტემა | გლობალური |
