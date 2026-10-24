# PetHub system review, workflow upgrades and production readiness (2026-10-24)

Base: commit `e320877` (clean). All code changes below are **uncommitted and not deployed**. One database migration
**was applied** to the live Supabase project (`crudvruwaptsvesheijv`); it is backward compatible with the code that is
deployed now. No account credentials, roles or profile data were changed by this work.

Test levels used in this report:
- **Local**: automated suites against the real Express app with an in-memory database (`tests/helpers/harness.js`).
- **Isolated full stack**: real Chrome, real frontend, real Express app (this working tree), in-memory database; the
  frontend's Railway URL redirected to the local app. Nothing external contacted.
- **Live**: the production database, through the new backend running locally (port 5055), read-only requests and
  requests the server refuses before writing. The deployed Vercel/Railway apps still run `e320877`.

---

## 1. Overall assessment

PetHub's foundations were already solid: backend-only database access with a service-role key, RLS on with no API-role
grants, signed session tokens with the role re-read from the database, race-safe booking/approval functions, and a
large test suite. The gaps were in the workflows this review targeted:

| Area | Before | Now |
| --- | --- | --- |
| Service activation | Switch disabled until duration/species existed; settings edited in a second, duplicate list | One row per service; switching on an incomplete service opens a setup dialog; "Save and turn on" in one request |
| Contact | Anyone could post any name/email; no subject; admin could only mark read | Login required; sender taken from the account; subject; admin reads, replies once (stored + emailed); customer sees replies |
| Cancellation | Worked, with a bare `confirm()` and a fire-and-forget email | Confirmation dialog naming the appointment; awaited, logged confirmation email; failure reported to the owner and resendable by the clinic; "cancelled by owner/clinic" visible |
| Emails | Not recorded anywhere | `email_logs` row per appointment/reply email (Pending → Sent/Failed), duplicate-proof, admin resend |
| Status history | Table existed, never written | Database trigger writes every status change, whatever path makes it |
| Clinic contact info | None anywhere in the system | Admin-editable (`system_settings`), shown on the Contact page and in emails; nothing invented |

Readiness: functionally ready for a capstone demonstration once deployed. Online booking stays closed until the clinic
enters real durations (no values were invented). See section 21 for what remains.

## 2. Pages inspected (live, with both supplied accounts, desktop 1280 px and phone 390 px)

Public: Home, About, Services, Contact, Privacy, Login, Register. Owner: Overview, My Pets, Appointments, Pet Health &
AI Assistant. Admin: Overview, Appointment Management, Pet Owners & Records, System Management (Users, Contact messages,
Activity logs, Services & booking), Breed Catalog. No JavaScript errors, no failed API calls and no sideways scrolling
were found on the deployed site; findings below are about behaviour and usability.

## 3. Pet owner dashboard findings

| Finding | Action |
| --- | --- |
| "Recent activity" showed only sign-ins/sign-outs; bookings were never logged at all | Bookings now logged (`appointment_booked`); owner view leaves out sign-ins (`?exclude=sign_ins`); friendly labels and times |
| Default "Upcoming" filter showed "No appointments match these filters" when the owner had history | Empty state now says "No upcoming appointments", counts the history and offers "Show history" |
| Cancel used `window.confirm` with no appointment details | Dialog with pet, service, date, time, reference and the clinic-time deadline; "Keep appointment" changes nothing |
| Cancelled cards did not say who cancelled or when | "Cancelled: By you / By the clinic · date, time" |
| AI assistant | Already labelled "General information only… not a diagnosis", emergency guidance, no pet data sent. No change |
| Profile / My Pets | Working; test account's pet data left untouched |

## 4. Admin dashboard findings

| Finding | Action |
| --- | --- |
| Every service listed twice (switch list + nine "Edit X" accordions) | Merged: one row with setup badge, description, switch and "Edit details" (same dialog) |
| Incomplete service switch was disabled with a hint to find another section | Switch always usable; opens setup with the missing fields marked |
| Admin could approve a request whose time had passed (owner emailed "Approved") and complete next month's visit | Server refuses both (409); buttons hidden with a note |
| No view of who cancelled, or of failed emails | Status cell shows "By the owner / By the clinic (name) · time" and "… email not delivered — Resend email" |
| Activity log dominated by sign-ins | "Show sign-ins and sign-outs" toggle, off by default (server-side filter, so 50 useful entries load) |
| Overview had no online-booking state | "Online booking: X of Y services open" shortcut to the services tab |
| "Today", "awaiting outcome" used the browser's timezone | Clinic clock (Asia/Manila) everywhere in the admin page |
| Contact messages: name/email/message only, mark-read only | From (with account badge), subject + preview, status Unread/Read/Replied, dialog to read and reply, resend failed reply email |
| Renaming a booked service silently detached its appointments (stored by name) | Rename refused when the service has appointments; name field locked in the dialog |

Kept as is (useful, no duplication found): Pet Owners & Records drill-down, Breed Catalog, Users/roles with last-admin
guard, charts.

## 5. Public website findings

| Finding | Action |
| --- | --- |
| Contact form accepted any name/email from anyone | Login required (see 7) |
| No clinic phone, email or address anywhere on the site | Clinic details card fed by admin settings; shows a clear "not published yet" message instead of placeholders |
| Services page showed internal reasons ("Online booking is disabled for this service.", "Applicable species have not been confirmed.") | "Not available for online booking right now. Contact the clinic"; "For dogs and cats" / "Ask the clinic which pets this service is for." |
| Login only returned visitors to the booking page | `?next=contact` also accepted (whitelist), kept through Register → Verify email → Login |
| Privacy notice described the old contact form | Updated for account-linked messages, replies and email delivery records |

## 6. Service activation (admin)

- Uses the existing `pethub_service_catalog.online_booking_enabled`, `duration_minutes`, `species` and the existing
  database check that refuses "on" without a duration and species. No schema change was needed for this feature.
- Flow: switch ON → if settings are missing, dialog "Set up <service> for online booking" marks them ("Required to
  turn on online booking"); client checks the same rules as the server (duration 5–480 whole minutes, ≥ 1 species,
  name 1–100, description ≤ 500, order 1–99); "Save and turn on" sends one `PUT /admin/services/:id` with
  `online_booking_enabled: true` and `expected_version`. On error the dialog stays open with the reason and the switch
  stays off; a 409 (changed elsewhere) reloads the latest settings. Complete services switch on/off directly.
- Booking side (unchanged, re-verified): only bookable, species-eligible services are listed; every booking re-checks
  the service, availability, configuration, species, date/time and conflicts on the server and again inside
  `create_appointment_if_available`. A service switched off after the page loaded is refused with a clear message.
  Switching off never touches existing appointments.

Files: `frontend/js/admin/dashboard.js` (services section rewritten), `frontend/pages/admin/dashboard.html`,
`backend/services/serviceCatalogService.js` (rename guard, `has_appointments`), `frontend/assets/css/input.css`.

## 7. Contact: login required

- `POST /contact` now runs `requireAuth` and a per-account rate limit. Body: `{ subject, message }` only. The service
  loads the account and stores `user_id`, `fullname` and `email` from it; a body `user_id` that is not the token's is
  refused by `requireAuth` (403); names/emails in the body are ignored. Unverified accounts are refused. An identical
  subject + text from the same account within 10 minutes returns the first message (double-click/retry safe).
- Signed out: clinic details + "Please log in to your PetHub account to send us a message." with Log in / Create an
  account (both `?next=contact`). Without JavaScript the login prompt is what shows.
- Signed in (customer): "Sending as <name> (<email>)", subject, message with counter, inline validation, success
  message, and "Your messages" (`GET /contact/mine`) with status (Sent / Seen by the clinic / Answered) and replies.
- Clinic staff: pointed to the Admin Dashboard.
- Admin: open → marked read; one reply per message (`POST /admin/dashboard/contact-messages/:id/reply`), stored with
  `replied_at`/`handled_by`, then emailed to the stored account address; a failed reply email keeps the reply and can
  be resent. Replies never go to an address typed in a form.

## 8. Appointment cancellation (two-hour cutoff)

Existing and kept: `POST /appointments/cancel/:id` (token owner only), Pending/Approved only, inclusive cutoff
(start − 2 h) checked in Node on the Asia/Manila clock and again atomically in `cancel_appointment_for_owner`
against PostgreSQL's clock; idempotent repeat (`already_cancelled`). Added:
- `cancelled_by` recorded by the database function (owner) and by the admin paths; owners see "By you / By the clinic"
  (never an admin id); admins see owner vs clinic and the time.
- Confirmation dialog and server-message feedback (section 3).
- Status history trigger records the change.

Verified: exact cutoff allowed, 1 h 59 min refused, after start refused, another owner's appointment 404, Completed /
Cancelled refused, concurrent requests produce one change and one email (local tests); the live database function was
exercised in a rolled-back transaction (section 10).

## 9. Cancellation confirmation email

Subject "Your PetHub Appointment Has Been Cancelled"; body: "Your appointment has been successfully cancelled. Your
PetHub appointment details are listed below for your reference." with reference, customer, pet, service, original date,
original time, status, "Cancelled on … (Philippine time)", what to do if it was not them, and a "Need help?" block with
the clinic's published details (or the signed-in Contact page link when none are published).

Reliability: sent only after the database reports the change (the function returns true once), **awaited** (Brevo
15 s timeout) so the response says `email_status: sent | failed | skipped | duplicate`; the owner is told when delivery
could not be confirmed; the cancellation is never undone. Every attempt is an `email_logs` row (Pending → Sent/Failed
with Brevo's status/code only — no key, no content); a unique index allows one email per type per appointment, so a
retried request cannot send twice; admins resend a Failed email once at a time (`Failed → Pending` conditional claim).
This is the pattern recommended by the outbox literature (record, then send, idempotent key) without adding a worker
process, which this one-instance capstone deployment does not need.

Note: the provider is **Brevo** (migrated in `a6f7638`), not SendGrid. The sender address is still read from
`SENDGRID_FROM_EMAIL`/`SENDGRID_FROM_NAME`; `SENDGRID_API_KEY` in `.env` is unused.

## 10. Database changes

`database/migrations/2026-10-24_contact_cancellation_email_log.sql` — **applied 2026-10-24 05:35:15 UTC** via the
Supabase MCP, one transaction, after a genuine live dry run.

| Object | Change |
| --- | --- |
| `contact_messages` | + `user_id` (FK users, ON DELETE SET NULL), + `subject`, + `reply_message`; checks: status ∈ Unread/Read/Replied, subject 1–120, message 1–2000, reply 1–2000, Replied ⇒ reply + replied_at; index `(user_id, created_at DESC)` |
| `appointments` | + `cancelled_by` (FK users, SET NULL); check: only on Cancelled rows |
| `cancel_appointment_for_owner`, `update_appointment_status_if_available` | Same signatures/logic, now also set `cancelled_by` |
| `record_appointment_status_history()` + trigger | AFTER INSERT / UPDATE OF status on appointments → `appointment_status_history` |
| `email_logs` | + `appointment_id`, + `contact_message_id` (FKs, SET NULL); status check; unique per (appointment, type) and (message, type) |
| Privileges | New function revoked from PUBLIC/anon/authenticated (the project's default privileges would have granted them) |

Evidence: preflight + post-check blocks inside the file; dry run (no BEGIN/COMMIT, ending in a deliberate error) proved
owner cancel sets `cancelled_by` + history, another account and a repeat return false, 1 h 59 min refused, admin path
history, all new checks and the unique index refuse bad rows, anon cannot execute; confirmed rolled back. Executed
statement SHA-256 (from the Postgres log) = file SHA-256 `ef12858793fe…4cf8`. Constraints 71 → 82, indexes 37 → 41.
Every pre-existing row of every table hashed identically before and after. Ledger: `database/migrations/APPLIED.md`.
No rows were backfilled (no invented history).

## 11. Backend changes

New: `constants/clinic.js`, `validators/clinicSettingsValidator.js`, `repositories/emailLogsRepository.js`,
`repositories/systemSettingsRepository.js`, `services/emailDeliveryService.js`, `services/emailRetryService.js`,
`services/clinicSettingsService.js`, `templates/email/contactReplyEmail.js`.
Changed: `routes/contact.js` (login required, `/mine`, `/clinic-info`), `routes/admin.js` (reply, clinic settings,
email retry), `routes/appointments.js` + `controllers/appointmentsController.js` (removed the unused duplicate
`PUT /appointments/updateStatus`), `services/contactService.js` (rewritten), `services/appointmentNotificationsService.js`
(logged sends, awaited owner confirmation, retry builder), `services/appointmentsService.js` (owner mapping, messages
by email outcome, booking activity log), `services/adminService.js` (time rules, who-cancelled, email deliveries,
booking summary, sign-in filter, labels; contact handlers moved out), `services/serviceCatalogService.js`,
`services/authService.js` + `repositories/activityLogsRepository.js` (sign-in filter), `repositories/appointmentsRepository.js`,
`repositories/contactRepository.js`, `validators/contactValidator.js`, `templates/email/appointmentEmailParts.js`
(reference "PH-XXXXXXXX" instead of the raw id, clinic help block), `templates/email/appointmentDecisionEmail.js`,
`constants/email.js`, `constants/rateLimits.js`, `controllers/adminController.js`, `controllers/contactController.js`.

## 12. Frontend changes

New: `js/public/contact.js`. Changed: `pages/public/contact.html`, `pages/public/privacy.html`,
`pages/user/appointments.html` + `js/user/appointments.js` (dialog, history empty state, who cancelled),
`js/user/dashboard.js` (activity), `pages/admin/dashboard.html` + `js/admin/dashboard.js` (services, messages dialog,
clinic details, resend, time rules, clinic clock, booking shortcut, activity toggle), `js/public/services.js`,
`js/core/auth.js`, `js/core/storage.js`, `js/core/verify.js` (`next=contact` chain), `assets/css/input.css` +
rebuilt `style.css` (shared `.ph-dialog`, Contact layout, message thread, missing-field highlight, dark mode, phone-width
fix for service rows).

## 13. Security review

| Check | Result |
| --- | --- |
| Identity | Signed HMAC token; any claimed `user_id`/`X-User-ID` must equal it (403 otherwise); roles re-read from DB on every admin request |
| Ownership | Pets, appointments, records, own messages all scoped to the token's user in the query (OWASP IDOR guidance). Live: cancelling a random/other appointment 404, owner on every admin route 403 |
| Contact impersonation | Not possible: identity from the account record; verified live (403 on spoofed `user_id`) and locally (body name/email ignored) |
| Service availability | Admin only (403 for owners, live) |
| Database | RLS on all 17 tables, no API-role grants, functions executable only by postgres/service_role; advisors show INFO only |
| Email | Only to stored account addresses; Brevo key never logged (tested); HTML escaped (tested with markup in names, pet names, replies) |
| Passwords | scrypt; one older owner account is still stored in plaintext and upgrades on its next login (existing behaviour; hashing it without a login needs separate authorization) |
| Open | CORS accepts any `*.vercel.app` origin (low risk: bearer tokens, no cookies); tokens cannot be revoked before expiry (8 h); no CSP/security headers on Vercel; Chart.js/Remixicon from CDNs without SRI. See 16/21 |

## 14. External references consulted

| Reference | Used for |
| --- | --- |
| [W3C APG Switch pattern](https://www.w3.org/WAI/ARIA/apg/patterns/switch/) | `role="switch"` + `aria-checked` on service toggles (kept, now never disabled) |
| [W3C APG Dialog (Modal) pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) | Native `<dialog>`/`showModal()`, focus to first relevant field, Escape closes, focus returns to the trigger |
| [NN/g, "Confirmation Dialogs Can Prevent User Errors — If Not Overused"](https://www.nngroup.com/articles/confirmation-dialog/) | Specific cancel dialog (names the appointment), outcome-labelled buttons ("Keep appointment" / "Cancel appointment"), no dialog for reversible actions such as switching a service off |
| [OWASP IDOR Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Insecure_Direct_Object_Reference_Prevention_Cheat_Sheet.html), [OWASP IDOR](https://owasp.org/www-community/attacks/insecure_direct_object_reference) | Server-side ownership on every object; tested with two accounts |
| [Transactional outbox (MikroORM docs)](https://mikro-orm.io/docs/transactional-outbox), [outbox recipe](https://warlock.js.org/v/latest/cascade/recipes/outbox-pattern/) | Record-then-send with an idempotency key and single-claim retries (`email_logs`) |
| [Talkatoo: preventing no-shows](https://talkatoo.com/blog/best-practices-for-preventing-no-shows-at-your-veterinary-practice/), [VETport](https://vetport.com/Tackling-No-Show-At-Veterinary-Practice), [ezyVet](https://www.ezyvet.com/blog/how-veterinary-practices-can-reduce-no-show-rates), [PetDesk](https://petdesk.com/blog/the-top-5-reasons-for-no-shows-at-your-veterinary-practice) | Clinic cancellation windows range from ~3 h to 48 h and are communicated at booking; reminders 24–72 h ahead are common practice (vendor sources, no rigorous veterinary study found). The 2-hour cutoff is shown at booking and in the dialog |
| [Philippine Data Privacy Act (NPC)](https://privacy.gov.ph/data-privacy-act/) | Transparency/proportionality: privacy notice updated for messages, replies and email logs |

Established practice (APG, OWASP) was followed directly; vendor sources informed recommendations only.

## 15. Independent AI review

A separate agent reviewed the code read-only (no network, no edits). Its points and the decision on each:

| Recommendation | Decision |
| --- | --- |
| B4: approve after start / complete before start allowed | **Adopted** (server + UI, tests) |
| B8: renaming a service breaks its history | **Adopted** (rename guard + locked field) |
| Remove unused `PUT /appointments/updateStatus` | **Adopted** (duplicate status logic removed; 404 tested) |
| Admin timezone uses the browser clock | **Adopted** (clinic clock in admin page) |
| B1: one account can hold many Pending slots | Recommended: cap active future requests per account (needs a clinic-chosen number) |
| B2: no opening hours / booking horizon | Recommended: needs the clinic's real hours (not invented); clinic hours text now exists for display only |
| B3: pets under 1 year cannot be registered | Recommended (age 1–25 was an earlier explicit decision; puppies/kittens are typical patients) |
| B5: admin lists unpaginated (1000-row API cap) | Recommended for growth; not an issue at current size (5 users, 2 appointments) |
| B6: tokens not revocable; no security headers/SRI | Recommended (`token_version`, `vercel.json` headers) |
| B7: email verification code has no attempt counter; 404 reveals accounts | Recommended (needs a schema column; verified the attempt counter exists only for password resets) |
| B9: stale lock comment on pet delete | Low; FK is `ON DELETE SET NULL` live; noted |
| B10: CORS `*.vercel.app` | Recommended: pin to project hostnames when deployment URLs are final |
| Visit-progress tracking (checked in → ready) | Deferred: new feature needing clinic workflow input |
| Admin walk-in bookings, owner notes, clinic inbox emails | Recommended (Priority 4) |
| Remove unused admin endpoints, tables, columns, redirect stubs | Recommended separately (may affect data/tests; not done) |
| Registration data minimisation | Not re-opened: required fields were an earlier explicit decision; flagged for the clinic's privacy purpose statement |

## 16. Features recommended for addition (not implemented)

| Feature | Problem → benefit | DB | Backend | Frontend | Security | Effort |
| --- | --- | --- | --- | --- | --- | --- |
| Appointment reminders (24 h before) | No-shows → fewer missed slots | use `reminder_logs` or `email_logs` type | scheduled job (Railway cron) + idempotent send | none | same as other emails | Medium |
| Clinic inbox notification on new request / owner cancellation / message | Staff learn without polling | none | email to `clinic.email` setting | none | rate-limit | Low |
| Pending-request cap per account | One account blocking the calendar | function change | count in RPC | message | abuse control | Low |
| Opening hours + booking horizon | Bookings at 3 AM or years ahead | settings + function | validate in RPC | time picker hints | none | Medium |
| Session revocation (`token_version`) | Logout/password reset don't end other sessions | 1 column | check on requests | none | stronger | Medium |
| Security headers (`vercel.json`), SRI | XSS/CDN impact | none | none | config | stronger | Low |
| Pet age "under 1 year" or birth date | Puppies/kittens | maybe column | validator | form | none | Low–Medium |

## 17. Recommended removals (need separate approval; not done)

Unused API routes (`/admin/dashboard/{stats,users,pets,appointments}`, `/admin/analytics/*`, `POST
/pets/medical-records/create` stub); unused tables `notifications`, `reminder_logs` (unless reminders are built),
`payments` (export its one row first); unused columns `appointments.appointment_reference, notes, payment_status,
reminder_sent, confirmed_at, deposit_required`; legacy redirect pages (`pages/admin/{appointments,pets,users}.html`,
root `dashboard.html`, `admin-dashboard.html`); legacy plaintext-password acceptance once the last account is hashed;
the stale `pethub-beige.vercel.app` deployment.

## 18. Simplified in this work

Duplicate service settings list removed; duplicate admin status endpoint removed; contact admin logic moved out of the
1,400-line `adminService.js` into `contactService.js`; one shared `.ph-dialog` style for all new dialogs; status line
ordering fixed so success messages are not wiped by reloads.

## 19. Tests actually performed

| Level | What | Result |
| --- | --- | --- |
| Local | Backend suite (`node --test --test-concurrency=4`) | **329 / 329 pass** (baseline 312; 19 new workflow tests, updated tests for intended behaviour changes) |
| Local | Browser mode (`PETHUB_BROWSER_TESTS=1`, headless Chrome, mocked API) | **438 / 438 pass** (baseline 410; new contact/cancel/admin-message/service-setup/phone-width tests) |
| Local | Mutation checks: 15 safeguards broken one at a time (files restored byte-for-byte) | 14 caught (2 only after adding service-level tests for the duplicate-email and concurrent-retry guards); the phone-width CSS fix is **not** caught in the mocked browser (fonts/icons blocked) — verified live instead |
| Isolated full stack | Real Chrome + frontend + new Express + in-memory DB, 8 flows (contact login/return/send, admin reply + email, owner cancel + email, failed email + resend, service setup, time rules) | **8 / 8 pass**, no JS errors, no outbound requests |
| Live DB | Migration dry run with behaviour checks (rolled back) | All checks as expected |
| Live DB | Migration applied; structure, privileges, row hashes, executed-statement hash | Verified |
| Live | New backend on production data: 29 read-only / refusal checks with both accounts | **29 / 29 pass** |
| Live | New frontend + new backend on production data, 1280 / 390 / dark: 30 page states incl. setup dialog (opened, not saved) | No JS errors, no non-2xx responses, no sideways scroll, 0 overflowing service rows (after the fix) |
| Live | Deployed site (old code) inspected with both accounts | No errors; findings in 3–5 |

Not performed live (by design): sending a contact message, replying, saving clinic details, activating a service,
cancelling or booking an appointment on production — these would create permanent production records (or require
invented service durations). They were verified in the isolated full stack and, for the database functions, in the
rolled-back live transaction.

## 20. Production data touched during testing

Only `activity_logs` rows from logins/logouts by the two supplied accounts. A separate account's password was upgraded
from plaintext to scrypt by its own login at 07:29 UTC (not part of these tests; the existing auto-upgrade).

## 21. Remaining problems

1. **Not deployed.** Deploy the backend (Railway) before or together with the frontend (Vercel): the new Contact page
   sends `{ subject, message }` with the token, which the old backend rejects.
2. **Online booking is closed**: all 9 services lack a clinic-confirmed duration; Puppy Cut also lacks species. The
   clinic must enter them (System Management > Services & booking).
3. **Clinic contact details are empty**: enter them under System Management > Contact messages.
4. One plaintext password remains (upgrades on that user's next login).
5. Verification and password-reset emails are not recorded in `email_logs`.
6. Items in 16 (reminders, request cap, hours, token revocation, headers) and the reviewer's B1/B2/B3/B5/B6/B7/B10.
7. The deployed site is stale until redeployed; `pethub-beige.vercel.app` is an old public copy.

## 22. Deployment readiness

Code: ready (all suites green, isolated full stack green, live read-only checks green). Database: already migrated and
compatible with both old and new code. Before demonstrating: commit, push, confirm Railway and Vercel both redeployed,
enter the clinic's real service durations/species and contact details, then run one real booking → approve →
owner cancel cycle on a test pet to confirm the emails arrive.
