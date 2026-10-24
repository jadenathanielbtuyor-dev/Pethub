# PetHub Final Completion Report

**A Web Portal for Pet Status Tracking and Service Scheduling.** Final stabilization phase, 2026-10-24 (Asia/Manila).

- Starting point: commit `068d7e7`, already on `main` and already deployed.
- Hardening: commit `f7f8840`, pushed and deployed, with documentation commit `5990826`.
- Additional requirements (section 29): commit `37742ab` (multi-pet booking, rescheduling, care reminders, service
  management, paged lists) and commit `fefb13a` (faster dashboard reads), both pushed and deployed after the production
  migration was applied. A documentation-only commit follows them.
- Live systems: Vercel frontend `https://pethub-zzz-duke1-s-projects.vercel.app`, Railway backend
  `https://pethub-production-f14d.up.railway.app`, and Supabase project `crudvruwaptsvesheijv`.

The report uses these test levels:

| Level | Meaning |
| --- | --- |
| **Local** | Automated suites run against the real Express app with an in-memory database. Browser mode adds headless Chrome with a mocked API. |
| **Isolated full stack** | Real Chrome loads the real frontend, served with the production security headers so the CSP is enforced. CDN files are fetched from jsDelivr, so their SRI hashes are really checked. Chrome talks to the real Express app from this code, backed by the in-memory database and a fake Brevo. No PetHub production system is involved. |
| **Live read-only** | Requests to the deployed Railway backend and production database that only read data, or that the server refuses before writing anything. |
| **Live write** | Production writes made deliberately, with the two designated test accounts. Each one is listed in section 24. |

---

## 1. Executive summary

PetHub is deployed, stable and ready to demonstrate. This phase closed the remaining critical and high-priority
security items and verified every workflow that can be verified without clinic data:

- **Sessions now end when they should.** Every login creates a server-side session row, and the backend checks it on
  every signed-in request. Logging out ends that session immediately, and a password reset ends every session of the
  account. Both were verified live: after logout, the old token gets 401.
- **Plaintext passwords no longer work.** Only salted scrypt hashes verify. The one account that still has a plaintext
  value can no longer log in with it and is told to use "Forgot password?". Removing that value from storage is the
  one database step that remains (section 8).
- **Security headers are live.** The frontend has a Content-Security-Policy plus frame, sniffing, referrer and
  permissions headers. Chart.js and Remixicon load with Subresource Integrity. The API sends its own strict headers.
  CORS is limited to PetHub's own Vercel deployments. All of this was verified on the deployed site: 0 CSP
  violations across 36 page states.
- **Contact messaging was verified live end to end.** A test message was sent, the admin read and replied, Brevo
  accepted the reply email, and Brevo then recorded it as **delivered**. The customer saw the reply.
- **A real bug was found and fixed before deployment.** In the first version of the session change, logout did not
  actually end the session. The isolated full-stack run caught it, and a regression test now covers it.

The additional requirements are also implemented, migrated, deployed and live-verified (section 29):

- **Multi-pet booking.** One booking covers 2 to 6 of an owner's pets. Each pet gets its own appointment and its own
  time slot, one after another. The booking is saved completely or not at all.
- **Per-pet management.** The admin approves, completes, reschedules or cancels each pet's appointment separately, or
  cancels the whole booking in one step. Each change is recorded on that pet's appointment, and the owner's email
  names every pet.
- **Pagination.** The breed catalog and the service activity history are paged and filtered in the database.
- **Care reminders.** A reminder is created only after a completed visit. A due date comes only from a rule the clinic
  configured; without a rule, the reminder tells the owner to ask the clinic and gives no date. Each reminder explains
  itself, and none books anything. Owners can acknowledge or dismiss them; an admin can override one with a reason.
- **Service management.** Admins add services and switch them on or off. A service that has appointments is never
  deleted, and every change is recorded with who made it and when.
- **The production migration was applied** on 2026-10-24 at 15:25:37 UTC, after a live dry run. Every pre-existing
  row hashed identically before and after.
- **The admin overview is faster.** It now runs its database reads in parallel, cutting its response time from
  2.6–5.8 s to 1.1–1.9 s on Railway.

**Live booking.** An administrator has since configured all 9 services in System Management (30 minutes each, Puppy
Cut for dogs only) and switched them on, so online booking is now open. Real appointments exist (1 Pending, 1
Approved, 2 Completed) and were not touched. The clinic's contact details are still unpublished. No values were
invented.

## 2. Previous report reconciliation

The previous report is `backend/docs/pethub-system-review-2026-10-24.md`. Each claim was checked against the code
and the live systems.

| Previous report said | Found on 2026-10-24 | Action in this phase |
| --- | --- | --- |
| Code is uncommitted and not deployed | The user had committed it as `068d7e7`. Both hosts were already running it: the deployed `contact.html` was byte-identical to HEAD, and the new `/contact/clinic-info` endpoint answered on Railway | None needed |
| `2026-10-24_contact_cancellation_email_log.sql` applied at 05:35Z | Verified live. Constraint and index counts (82 and 41) matched the ledger, and every new column, trigger and function was present | Not re-run |
| One account still stores a plaintext password | Confirmed: one verified customer account with no pets and no appointments | Login no longer accepts it. The file that removes it from storage was blocked (section 8) |
| Sessions stay valid for up to 8 h; logout does not end them | Confirmed: `requireAuth` only checked the token's signature and expiry | Server-side sessions added (section 9) |
| No CSP or security headers on Vercel; CDN files without SRI | Confirmed: Vercel sent only HSTS | `frontend/vercel.json`, API headers and SRI added (section 10) |
| CORS accepts any `*.vercel.app` origin | Confirmed | Limited to PetHub's own Vercel deployments |
| Sender read from `SENDGRID_FROM_EMAIL`; `SENDGRID_API_KEY` unused | Confirmed | `BREVO_SENDER_EMAIL`/`BREVO_SENDER_NAME` added, with the old names as a fallback (section 11) |
| 9 services exist; none has a confirmed duration | Confirmed live: all 9 are off and none has a duration | None. Real clinic values are required |
| Clinic contact details are empty | Confirmed: `system_settings` has 0 rows | None. Real clinic values are required |
| Opening hours are not configured | Confirmed, and nothing enforces opening hours | Documented (section 14) |
| Verification and reset emails are not recorded in `email_logs` | Still true | Documented as a limitation |
| Contact messages and replies were never sent live | Previously true | Now done live with the test accounts (section 13) |
| Booking and cancellation were never run live | Still impossible without an active service | Covered by the isolated full stack (sections 14–15) |

## 3. Final architecture assessment

```
Browser ──HTTPS──> Vercel (static HTML, Tailwind CSS, vanilla JS; CSP + security headers)
   │
   └──fetch + Bearer token──> Railway (Node.js / Express 5 API; security headers; CORS allowlist)
                                 │  service-role key, server-side only
                                 ├──> Supabase PostgreSQL (RLS on all 21 tables, no API-role grants;
                                 │      single and multi-pet booking, cancel, reschedule and status changes as
                                 │      atomic SQL functions; status-history trigger)
                                 ├──> Brevo (transactional email; every appointment/reply email logged)
                                 └──> Google Gemini (general pet-care assistant; no pet records sent)
```

The architecture is the agreed stack (HTML, Tailwind and vanilla JavaScript; Node and Express; Supabase PostgreSQL)
and is unchanged. The browser never talks to Supabase directly; every database query goes through the backend.

## 4. Frontend findings

| Finding | Result |
| --- | --- |
| Inline scripts | One shared dark-mode bootstrap on 14 pages, plus three one-line redirect stubs. The CSP allows each of them by SHA-256 hash. The two multi-line redirect scripts moved into `js/core/role-redirect.js`. There are no inline event handlers. |
| CDN assets | Chart.js now loads from its published file `chart.umd.js@4.4.0`. The `.min.js` URL used before is generated by jsDelivr on the fly, so its bytes, and therefore an SRI hash, are not guaranteed to stay stable. Remixicon 4.3.0 CSS also has SRI. Both hashes were cross-checked against jsDelivr's own published file hashes. |
| Google Fonts | Its CSS changes per browser, so SRI is not possible. It is allowed by origin in the CSP. |
| Console errors, failed requests, sideways scrolling | None live, across 36 page states (section 24) |
| Tailwind build | A one-shot build of the current sources is byte-identical to the committed `style.css`. |

## 5. Backend findings

| Finding | Action |
| --- | --- |
| `requireAuth` never touched the database, so a token could not be revoked | It now checks the token's session row on every request: it must exist, belong to that account, not be revoked and not be expired |
| `controllerFactory` passed services only `body`, `query`, `params`, `headers` and `authUserId` | **Real bug in the first version of this change.** Logout therefore revoked nothing. Now `authSessionId` is passed too. The isolated full stack caught it before deployment, and backend tests plus a mutation check now cover it |
| Unused `optionalAuth` middleware, which would have skipped the session check | Removed (it was referenced nowhere) |
| Login still upgraded plaintext and `sha256$` passwords on first use | Removed; only scrypt hashes verify |
| `sendEmail` discarded Brevo's message id | It now returns the id, and the id is logged. A "Sent" email can be traced in Brevo's logs |
| The retry endpoint called a Sent email "already delivered" | Corrected. Brevo's 201 response means accepted, not delivered |

## 6. Database findings

The live database was inspected through the Supabase MCP.

**Structure.** There are 21 public tables. RLS is on for all 21, with 0 policies and 0 grants to
`anon`/`authenticated`. Only the backend's service role reaches the data. The 7 functions can be executed only by
`postgres` and `service_role`:

- `create_appointment_if_available`
- `cancel_appointment_for_owner`
- `update_appointment_status_if_available`
- the status-history trigger function
- `create_appointment_group_if_available` (new)
- `cancel_appointment_group_by_clinic` (new)
- `reschedule_appointment_if_available` (new)

**Counts.** There are 118 constraints and 54 indexes. The `user_sessions` table added 5 constraints and 2 indexes. The
additions migration then added 31 constraints and 11 indexes (section 29).

**Supabase advisors** report INFO-level findings only:

- RLS enabled with no policies: intentional, because only the backend reads the database.
- 15 unindexed foreign keys and 7 unused indexes: on tables with single-digit row counts. Left alone.

**Production data at the start of this phase:** 5 users, 3 pets, 2 appointments (both Completed), 0 medical records,
90 breeds and 9 services.

**Production data after the additions migration (15:45 UTC):** 6 users, 5 pets, 4 appointments, 1 medical record, 90
breeds and 9 services (all configured and switched on). The new tables are still empty: 0 multi-pet bookings, 0 care
rules and 0 care reminders. The new users, pets, appointments and medical record were created through the
application, not by this work. This work's own production writes are listed in section 24.

No production record was deleted or altered.

**Possibly unused objects.** Classified from code references, SQL and trigger references, foreign keys and data.
Nothing was deleted.

| Object | Code references | Rows / data | Classification |
| --- | --- | --- | --- |
| `notifications` | none | 0; foreign key to `users` (cascade) | Confirmed unused |
| `reminder_logs` | none | 0; foreign key to `appointments` (cascade) | Confirmed unused; reserved if appointment reminders are built |
| `payments` | none (online payments were removed) | 1 row from the PayMongo period | Required for historical records |
| `appointments.payment_status`, `deposit_required` | none | 1 row with non-default values | Required for historical records |
| `appointments.appointment_reference`, `notes`, `reminder_sent`, `confirmed_at` | comments only | all empty | Confirmed unused |
| `users.last_login_at`, `profile_image` | none | never written | Confirmed unused |
| `appointment_status_history` | written by the database trigger, not by app code | 0 (no status change since the trigger was added) | Active |
| `system_settings` | clinic details | 0 (nothing published yet) | Active |

## 7. Security findings

Each control is listed with how it was verified.

| Control | Verification |
| --- | --- |
| Identity: HMAC-signed bearer token naming a server-side session; any `user_id`/`X-User-ID` claim must match it | Local tests; live check (claiming another user returns 403) |
| Roles re-read from the database on every admin request | Live: the owner account got 403 on all 7 admin routes tried |
| Ownership: pets, appointments, records and messages filtered by the token's account | Live: another account's pets return 403, another or unknown appointment's cancel returns 404 |
| Contact sender cannot be impersonated (identity comes from the account record) | Live: spoofed `user_id` returns 403; the live message stored the account's own name and email |
| Service availability: admin only, server-checked, cannot switch on without configuration | Live: owner got 403; admin got 422 for an unconfigured service, and its version stayed 1 |
| Service-role key kept server-side | Searching the frontend finds no key or project URL (the privacy notice only names Supabase as a provider) |
| Passwords | Section 8 |
| Sessions | Section 9 |
| Headers, SRI, CORS | Section 10 |

## 8. Password migration findings

**State before this phase.** Four accounts held scrypt hashes and one held a plaintext value: a verified customer
account (not a test account) with 0 pets and 0 appointments, last active 2026-10-18. The value itself was never read
or printed.

**Code: done and deployed in `f7f8840`.**

- `verifyPassword` accepts only PetHub scrypt hashes.
- Plaintext and `sha256$` values never verify, even when typed exactly.
- Any account with a non-hash value gets `403 password_reset_required` with the message: *For your security, this
  account needs a new password. Use "Forgot password?"…*
- The existing emailed-code reset (HMAC-hashed codes, 3 attempts, one open code per user, single use) then stores a
  scrypt hash and ends every session of the account.
- Covered by local tests, the isolated full stack (the login page shows the message and opens no session) and a
  mutation check.

**Storage: prepared, not applied.** `2026-10-24_remove_legacy_plaintext_password.sql` replaces the value inside the
database with a random `reset-required$…` marker. The value is never selected or returned, and an audit row records
the change. The Claude Code permission classifier blocked it before it reached the database, and it was not worked
around.

**Required action, either one of:**

1. A project owner runs that file in the Supabase SQL Editor. Its preflight and post-check verify the result. Or:
2. The account owner completes "Forgot password?", which replaces the value with a hash.

Until then, the old value stays in storage but cannot be used to sign in. This report does not reveal it.

## 9. Session management changes

**Migration.** `2026-10-24_user_sessions.sql` was **applied** at 2026-10-24 10:47:05 UTC, after a genuine live dry
run. The SHA-256 of the executed statement, taken from the Postgres log, equals the file's hash `f5e6924f…45ef`.

**Login.** Each login stores one row: who, created, expires, revoked and why. The row holds no token, IP address or
device. The signed token carries the row id and expires with it, after 8 h.

**Every signed-in request** checks the row. A token is refused with 401 when it is logged out, reset, expired, from
another account, unknown, or in the old token format without a session id. If the session table cannot be read, the
request gets 503 instead, so a database hiccup does not sign anyone out.

**Revocation:**

- **Logout** revokes the session it was sent with. Other devices stay signed in until they log out, so legitimate
  sessions persist.
- **Password reset** revokes every open session of the account.
- **Password change while signed in:** no such feature exists. Passwords change only through reset, which revokes
  everything.

**Deployment effect:** everyone signed in once more after the deploy, because old tokens have no session id.

**Verification:**

- Local: 10 session tests.
- Isolated full stack: UI logout, then putting the old token back in the browser sends it to the login page. A reset
  sends a signed-in tab to login.
- Live API: the owner's and admin's tokens return 401 after logout.
- Live browser: UI logout, then the old token returns 401, for both roles.

## 10. Security header changes

**Frontend (`frontend/vercel.json`). Live on Vercel since 10:48:33Z.**

| Header | Value / purpose |
| --- | --- |
| `Content-Security-Policy` | `default-src 'self'`. **Scripts:** only `'self'`, the exact Chart.js URL and 4 inline-script hashes; no `unsafe-inline`, no `unsafe-eval`. **Styles:** `'self'`, `'unsafe-inline'` (JS-rendered markup uses a few style attributes), Google Fonts and the Remixicon directory. **Fonts:** self, Google, Remixicon. **Images:** self and `data:`. **Connections:** `'self'` and the Railway API only. Also `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'` and `upgrade-insecure-requests`. |
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | camera, microphone, geolocation, payment and USB disabled |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Strict-Transport-Security` | Already sent by Vercel (`max-age=63072000; includeSubDomains; preload`) |

**API (`backend/middleware/securityHeaders.js`). Live on Railway since 10:48:56Z.** Every reply carries `nosniff`,
`DENY`, `no-referrer` and `default-src 'none'; frame-ancestors 'none'`. HSTS is sent on HTTPS. Replies to signed-in
requests carry `Cache-Control: no-store`.

**CORS:** allowed are the production alias, the Vercel branch and preview URLs of PetHub's own project, any
`localhost` origin, and `FRONTEND_URL`/`CORS_ORIGINS`. Any other `*.vercel.app` origin gets 403 (verified live).

**Verification:**

- A local test computes every inline script's hash and fails if the CSP is missing one or keeps a stale one.
- Isolated full stack under the real header: 0 violations, SRI files loaded, charts drawn.
- **Live** on the deployed site: 0 CSP or SRI violations across 36 page states. The icon font loads on every page and
  `Chart` is defined on the admin dashboard.

## 11. Email configuration and verification

**Provider.** Brevo is the only provider, through `utils/email.js`: Brevo's transactional API with a 15 s timeout.
Neither the key nor the email content is ever logged.

**Sender variables.** The sender is now read from `BREVO_SENDER_EMAIL` / `BREVO_SENDER_NAME`. When those aren't set,
`SENDGRID_FROM_EMAIL` / `SENDGRID_FROM_NAME` are used, so the current Railway configuration keeps working with no
change. `SENDGRID_API_KEY` is read nowhere and can be deleted.

**Railway variables.** I can't read them from here (there's no Railway CLI or access). Behaviour shows the required
ones are set: logins work (`AUTH_TOKEN_SECRET`), data loads with RLS deny-all (the service-role key), and Brevo
accepted and delivered an email sent by Railway (`BREVO_API_KEY` and a verified sender).

**Delivery states:**

| State | Where it is recorded |
| --- | --- |
| Pending | `email_logs` row created before sending |
| Accepted by Brevo | `email_logs.status = Sent` plus Brevo's message id in the server log |
| Delivered | Brevo's event log only. **Live evidence:** the contact-reply email to the owner test account was `requested` at 10:51:53Z and `delivered` at 10:51:54Z |
| Failed | `email_logs.status = Failed` with Brevo's status and code; an admin can resend it |

**Duplicate protection:** a unique index allows one email per appointment or message per email type. Resending a
Sent email is refused; this was verified live (409).

**A failed email never reverses the database change that caused it.** Verified locally and in the isolated full
stack.

Approval and cancellation emails were verified only locally and in the isolated full stack. Live, they need a
booking, and no service is bookable (section 14).

## 12. Service availability verification

**Live (read-only), at the time of the hardening deploy:**

- 9 services, all off. None had a clinic-confirmed duration, and Puppy Cut also had no species.
- The public catalog showed none of them as bookable.
- The server refused to switch on an unconfigured service (422), and the service's version stayed 1.

**Live, later the same day:** an administrator configured all 9 services in System Management between 11:14 and
11:15 UTC: 30 minutes each, Puppy Cut for dogs, every service switched on. This work did not set these values. The public catalog now shows all 9 as
bookable. The service activity history lists those changes (section 29).

**Isolated full stack:**

- Switching on Puppy Cut opens the setup dialog; "Save and turn on" saves the duration and species and switches it on.
- The owner then sees it, books an available service, and the admin approves it.

**Unchanged and re-verified by tests:** the server re-checks availability on every booking, and turning a service off
never touches existing appointments.

No durations or species were invented, so online booking stays closed until the clinic enters them.

## 13. Contact workflow verification

| Step | Live result |
| --- | --- |
| Visitor sees clinic details and a login prompt, with no form | Pass (no details are published, so the page says so) |
| Signed-out submission | 401 |
| Owner test account sends `[PetHub test] Final verification` | 201. Stored with the account's own `user_id`, name and email |
| Spoofed `user_id` | 403 |
| Admin sees it (with account badge), marks it read, replies | 200; `email_status: sent` |
| Second reply to the same message | 409 (one reply per message) |
| Email log | Sent. Brevo event: delivered |
| Resend of the Sent email | 409 |
| Owner sees "Answered" and the reply text | Pass |

## 14. Appointment workflow verification

**Lifecycle.** Pending → Approved | Cancelled → Completed. The rules:

- Approval is allowed only before the start time.
- Completion is allowed only after the start time.
- Owners can cancel only Pending or Approved appointments, up to 2 hours before the start.
- The database trigger writes the status history.

**Isolated full stack:**

- The owner booked Bath through the form and got a Pending appointment with the right pet, owner and time.
- The admin approved it with two clicks, the status became Approved, one approval email was sent and logged as Sent,
  and the owner saw "Approved".
- An appointment that had already started was completed.
- The approve and complete buttons were hidden where those transitions are invalid.

**Live:**

- At the time of the hardening deploy, booking was not possible because no service was bookable.
- Live read-only checks confirmed that the owner can't cancel a Completed appointment (409) or an unknown
  appointment (404), and that an invalid id is handled safely (404).
- Since the services were configured, appointments have been booked through the live site, though not by this work:
  there is now 1 Pending and 1 Approved appointment, alongside the 2 Completed ones. They were not touched.
- No test booking was made in production.

**Opening hours.** The server accepts any valid date and time in the future on the clinic clock. Every request needs
admin approval, and that is the safeguard against impossible times. No hours were invented, and no page displays
any. The clinic-hours text field exists for display once the clinic fills it in. Enforcing opening hours needs the
clinic's real schedule and is documented in section 27.

## 15. Cancellation and email verification

**Re-verified locally:**

- At exactly 2 h before the start: allowed. At 1 h 59 min: refused. After the start: refused.
- Completed or Cancelled appointments: refused. Another owner's appointment: 404.
- Concurrent requests produce one change and one email.

The live database function was exercised in a rolled-back transaction during review #4.

**Isolated full stack:**

- The dialog names the appointment; confirming cancels it.
- There is one cancellation record, `cancelled_by` is the owner, exactly one confirmation email is sent, and the
  admin sees "By the owner".
- A failed confirmation email keeps the cancellation, and the admin resent it once.

**Live:** no cancellable appointment exists, and real customer appointments are not touched.

## 16. User dashboard results

Live with the owner test account, at 1280 px (light) and 390 px (dark): Overview, My Pets, Appointments (with
history), Pet Health and AI Assistant, and Contact. The pages load the account's real data and show no JS errors, no
failed requests, no CSP violations and no sideways scrolling. UI logout ends the session.

The AI assistant answered a live question (200 in 4.2 s; general guidance only).

Appointment history is reachable from the "Show history" option (review #4).

## 17. Admin dashboard results

Live with the admin test account, at both sizes: Overview, Appointment Management, Pet Owners & Records, System
Management and Breed Catalog. There were no errors.

- The overview counts come from live records: 4 owner accounts, 3 pets, 2 appointments, 0 pending.
- Recent activity shows the test reply.
- Charts are drawn through the SRI-checked Chart.js.
- The overview endpoint took 2.6–5.8 s on Railway. Each backend-to-database round trip costs 220–450 ms, and the
  overview made about nine of them one after another. Since `fefb13a` the independent reads run together, and the
  overview takes 1.1–1.9 s. The Supabase edge log confirms the six reads now leave within 22 ms of each other.
  Simple signed-in requests take about 0.85 s, where network latency dominates.
- Admin-only behaviour (services, clinic settings, email resend, status changes) was verified live through refusals
  and the test reply, and the rest in the isolated full stack.

## 18. Public website results

Live, signed out, at both sizes: Home, About, Services, Contact, Privacy, Login, Register and Forgot password. All
pages load under the CSP with icons, with no errors and no sideways scrolling.

The Services and Contact pages say plainly that online booking and clinic details are not available yet. No
placeholders are presented as clinic facts.

## 19. Files modified

**Commit `f7f8840` (44 files):**

- **New, backend:** `middleware/securityHeaders.js`, `repositories/userSessionsRepository.js`,
  `database/migrations/2026-10-24_user_sessions.sql`,
  `database/migrations/2026-10-24_remove_legacy_plaintext_password.sql`, `tests/final-hardening.test.js`.
- **New, frontend:** `vercel.json`, `js/core/role-redirect.js`.
- **Changed, backend:** `config/env.js`, `constants/auth.js`, `middleware/requireAuth.js`,
  `repositories/usersRepository.js`, `server.js`, `services/authService.js`, `services/emailDeliveryService.js`,
  `services/emailRetryService.js`, `services/passwordResetService.js`, `utils/authToken.js`,
  `utils/controllerFactory.js`, `utils/email.js`, `utils/passwordHash.js`, `docs/backend-maintenance.md`.
- **Changed, tests:** `tests/helpers/harness.js`, `tests/helpers/fakeSupabase.js`,
  `tests/appointment-notifications.test.js`, `tests/profile-update.test.js`, `tests/registration.test.js`,
  `tests/security.test.js`.
- **Changed, frontend:** 18 HTML pages: SRI on Remixicon on every page, Chart.js URL and SRI on the admin dashboard,
  and `dashboard.html` / `admin-dashboard.html` now use the redirect file.

**Documentation commit `5990826`:** this report, `backend/database/migrations/APPLIED.md` and
`backend/docs/backend-maintenance.md`.

**Commit `37742ab` (58 files, additional requirements):**

- **New, backend:**
  - `constants/careRecommendations.js`, `constants/serviceActivity.js`
  - `controllers/careRecommendationsController.js`, `controllers/groupBookingController.js`
  - `repositories/careRecommendationsRepository.js`
  - `services/careRecommendationService.js`, `services/groupBookingService.js`, `services/rescheduleService.js`
  - `utils/pagination.js`, `validators/careRecommendationValidator.js`
  - `database/migrations/2026-10-24_multi_pet_booking_and_care_recommendations.sql`
- **New, tests:** `tests/multi-pet-and-care.test.js`, `tests/group-booking-and-care.browser.test.js`,
  `tests/admin-bookings-and-catalog.browser.test.js`.
- **New, frontend:** `js/shared/pagination.js`, `js/admin/booking-tools.js`, `js/admin/catalog-tools.js`,
  `js/user/group-booking.js`, `js/user/care-reminders.js`.
- **Changed, backend:**
  - constants: `appointments.js`, `email.js`
  - controllers: `serviceCatalogController.js`
  - repositories: `activityLogsRepository.js`, `appointmentsRepository.js`, `breedCatalogRepository.js`,
    `serviceCatalogRepository.js`
  - routes: `admin.js`, `appointments.js`, `pets.js`
  - services: `adminService.js`, `appointmentNotificationsService.js`, `appointmentsService.js`,
    `breedCatalogService.js`, `emailDeliveryService.js`, `emailRetryService.js`, `serviceCatalogService.js`
  - email templates: `appointmentDecisionEmail.js`, `appointmentEmailParts.js`
  - utils and validators: `utils/activityLogger.js`, `appointmentsValidator.js`, `breedCatalogValidator.js`,
    `serviceCatalogValidator.js`
  - docs: `docs/backend-maintenance.md`, `database/migrations/APPLIED.md`
- **Changed, tests:** `tests/helpers/fakeSupabase.js`, `tests/helpers/browser.js`, `tests/breed-catalog.test.js`,
  `tests/breed-catalog-page.browser.test.js`.
- **Changed, frontend:**
  - pages: `pages/admin/dashboard.html`, `pages/admin/breeds.html`, `pages/user/appointments.html`,
    `pages/user/dashboard.html`, `pages/user/pets.html`
  - scripts: `js/admin/dashboard.js`, `js/admin/breeds.js`, `js/user/appointments.js`
  - styles: `assets/css/input.css`, and `style.css` rebuilt in one shot

  No inline script changed, so `vercel.json` and its CSP hashes did not need to change. A check of all 20 pages
  found 17 inline scripts, all hashed, and no inline event handlers.

**Commit `fefb13a` (2 files):** `services/adminService.js` and `services/serviceCatalogService.js`. Their independent
database reads now run in parallel, and nothing else changed.

## 20. Database objects modified

**Created:** `public.user_sessions`, with:

- primary key and foreign key to `users` (`ON DELETE CASCADE`);
- 3 check constraints: `expires_at > created_at`; `revoked_reason ∈ {logout, password_reset}`; revoked time and
  reason set together;
- partial index `user_sessions_user_id_open_idx`;
- RLS on with no policies, privileges for `postgres` and `service_role` only.

**Created by the additions migration (section 29):**

- **Tables:** `public.appointment_groups`, `public.care_recommendation_rules` and `public.pet_care_recommendations`.
  Each has RLS on with no policies, and privileges for `postgres` and `service_role` only.
- **Columns:** `appointments.group_id` and `appointments.group_position` (NULL for single-pet bookings), and
  `activity_logs.event_type` (NULL for entries recorded before it existed).
- **Functions:** `create_appointment_group_if_available`, `cancel_appointment_group_by_clinic` and
  `reschedule_appointment_if_available`. Each is executable by `postgres` and `service_role` only.
- **Indexes:**
  - unique: one position and one pet per booking, one rule per service and species, and one open reminder per
    source;
  - lookup: booking requests, service activity by table and date, and owner reminders by status and due date.
- **Constraints:** checks on statuses, intervals (1–1825 days, minimum ≤ maximum), positions and lengths, plus the
  foreign keys.

No existing row was changed, and no existing object was dropped or rewritten.

## 21. Migrations applied

| File | State |
| --- | --- |
| `2026-10-24_user_sessions.sql` | **Applied** 10:47:05 UTC (dry run first; hash verified; recorded in `APPLIED.md`) |
| `2026-10-24_multi_pet_booking_and_care_recommendations.sql` | **Applied** 15:25:37 UTC through the Supabase MCP, with the owner's authorization. A live dry run with 9 behaviour checks ran first, then rolled back. The executed statement's SHA-256 equals the file's (`37113ba5…45bc`); the committed copy is byte-identical. Tables 18 → 21, indexes 43 → 54, constraints 87 → 118. Recorded in `APPLIED.md` |
| `2026-10-24_remove_legacy_plaintext_password.sql` | **Not applied**: blocked by the permission classifier on its first attempt; it changes a customer's stored credential, which needs its own explicit permission (section 8) |
| Earlier files (including `2026-10-24_contact_cancellation_email_log.sql`) | Verified in place; **not re-run** |
| `2026-10-24_optional_default_privileges.sql` | Still not applied (optional; affects future objects only) |

## 22. Test totals

**Final totals, after the additions (run on the committed code):**

| Level | Suite | Result |
| --- | --- | --- |
| Local | Backend (`npm test`) | **375 / 375** |
| Local | Backend + headless browser (`PETHUB_BROWSER_TESTS=1`) | **494 / 494** |
| Local | Mutation checks on the additions: 16 safeguards broken one at a time, files restored byte-for-byte | **15 / 16 caught.** The 16th ("reminder for any status change") has a second check behind it in the care-reminder service. The tests fail when both checks are removed |
| Isolated full stack | Earlier workflows, rerun on the new code | **15 / 15** |
| Isolated full stack | New workflows (section 29) | **10 / 10** |
| Live DB | Additions migration: dry run (9 behaviour checks, rolled back), apply, hash, structure, privileges, data fingerprints | Pass |
| Live DB | Query plans at realistic volumes, measured in rolled-back transactions | All under 13 ms (section 29) |
| Live schema, local backend | The new backend run locally against the migrated production database, before deploying | **23 / 23** |
| Live read-only | Additions on the deployed Railway backend | **23 / 23** |
| Live read-only | Earlier checks, rerun after the deploy | **31 / 33.** The 2 failures expected all services to be switched off; an administrator has since switched them on (section 12). No regression |
| Live browser | New screens on the deployed site: 2 sizes (1280 px light, 390 px dark), both roles, paging clicked, booking form opened and nothing submitted | **46 / 46**, with 0 CSP, SRI, JS or request errors |

**Totals from the hardening deploy (`f7f8840`):**

| Level | Suite | Result |
| --- | --- | --- |
| Local | Backend (`node --test --test-concurrency=4`) | **352 / 352** (baseline 329) |
| Local | Backend + headless browser (`PETHUB_BROWSER_TESTS=1`) | **461 / 461** (baseline 438) |
| Local | Mutation checks: 13 new safeguards broken one at a time, files restored byte-for-byte | **13 / 13 caught** |
| Isolated full stack | Production headers and CSP, real CDN with SRI, new backend, in-memory DB | **15 / 15** |
| Live DB | `user_sessions` dry run (rolled back), apply, structure and privilege verification | Pass |
| Live read-only | API checks with both test accounts (headers, CORS, ownership, admin refusals, logout revocation) | **33 / 33** |
| Live write | The same checks plus a controlled contact message, admin reply, duplicate and resend refusals | **41 / 41** |
| Live browser | Deployed site: 36 page states (2 sizes, light/dark, 3 roles) plus 2 UI logouts | **0 problems** |
| Live email | Brevo event log for the reply email | **delivered** |

## 23. Failed tests and their resolutions

| Failure | Cause | Resolution |
| --- | --- | --- |
| 9 backend tests after plaintext acceptance was removed | The tests seeded plaintext passwords and expected login to work | The harness now stores real scrypt hashes for `password`, with a `storedPassword` option for legacy values. The two legacy-behaviour tests were rewritten to assert the new rule |
| Full stack: "Logging out ends the session" | First, my script clicked the hidden phone-only logout link. Then a **real bug**: `controllerFactory` did not pass the session id, so logout revoked nothing | Script selector fixed. Code fixed, with 10 session tests and 2 mutation checks added |
| 1 new test (regex) and 1 new migration-file test | My own test patterns: a lost escape, and a pattern that was too broad | Corrected |
| `server.js` CORS regex lost its escapes during an edit | Edit tooling | Caught by inspection before any test run, and fixed |
| Classifier block on the legacy-password file | Production credential write needs explicit permission | Not worked around (section 8) |
| Breed catalog test after paging was added | The new default status filter was "active", which hid inactive breeds from an existing caller | The API default stays "all" (backward compatible). The test now finds the breed by search |
| Reschedule test | My test moved the in-memory row it was still reading | The test copies the row first |
| Admin browser test, intermittent | The test clicked a tab while the dashboard was still restoring the saved tab | The test waits until the dashboard has finished loading |
| Care rules and activity loaded twice when the Services tab opened | A click listener and the tab-switch hook both started them | **Real defect**, fixed with a once-only start |
| Whole-booking cancel button off-screen on a wide table | Layout | The booking header now stacks its button |
| Rolled-back performance query | Type cast in my query (`uuid` compared with `text`) | Query corrected; no code change |
| Classifier block on the additions migration (first attempt) | Production schema change | Not worked around. Applied only after the owner's explicit authorization |
| Admin overview 2.6–5.8 s live | About nine sequential database round trips at 220–450 ms each | **Fixed in `fefb13a`**: now 1.1–1.9 s |

## 24. Live production verification

**Live writes made, all with the designated test accounts:**

- 1 contact message, `[PetHub test] Final verification` (id `8da3fb14-…`), and its reply. Both are labelled as a test.
- 1 `email_logs` row (Sent, delivered).
- 10 `user_sessions` rows: 8 ended by logout. 2 remain open from the phone-width browser pass and expire at 18:54
  UTC.
- About 21 `activity_logs` rows from sign-ins, sign-outs, mark-read and reply.

**Live writes during the additions phase (15:20–15:45 UTC).** Every write used the two test accounts.

- The additions migration: schema only (section 21). No row was changed.
- 18 `user_sessions` rows (10 admin, 8 owner). 17 were ended by logout. One owner test session stays open until it
  expires at 23:27:49 UTC.
- 35 `activity_logs` rows: 18 sign-ins and 17 sign-outs.
- Nothing else. Since 15:20 there are 0 new appointments, 0 status-history rows, 0 service changes and 0 email logs.
  Every multi-pet, reschedule, rule and service request sent to the live API was one the server refuses before
  writing.

**Live read-only:** sections 12–18, 22 and 29.

**Production records not touched:** no customer appointment, pet, profile, password, service or setting was changed.
No message went to anyone other than the owner test account.

## 25. Deployment status

| Item | Status |
| --- | --- |
| Commit `f7f8840` pushed to `origin/main` | 10:48:21 UTC |
| Vercel frontend | **Deployed and verified** 10:48:33 UTC. New CSP and headers served; admin dashboard HTML byte-identical to the commit |
| Railway backend | **Deployed and verified** 10:48:56 UTC. New API headers live; sessions working live |
| Frontend ↔ backend connectivity | Verified live: logins, dashboards and contact from the deployed site; CORS allows only the expected origins |
| Backend ↔ Supabase | Verified: production project `crudvruwaptsvesheijv`; sessions written there |
| Documentation commit `5990826` | Pushed. Docs only |
| Additions migration | Applied to production at 15:25:37 UTC, **before** any code that uses it was pushed |
| Commit `37742ab` pushed to `origin/main` | 15:33:49 UTC |
| Vercel frontend (`37742ab`) | **Deployed and verified** by 15:34:21 UTC. All 14 changed pages, scripts and styles served byte-identical to the commit; CSP header unchanged and live |
| Railway backend (`37742ab`) | **Deployed and verified** by 15:34:41 UTC. The live additions checks passed 23 / 23 against it |
| Deployment order | Both hosts deploy automatically from the same push, and neither has a CLI here, so their order could not be set by hand. Ordering the migration first is what made this safe: the new frontend only calls endpoints that are live, and the old backend kept working against the migrated database during the seconds between the two deploys (the migration is additive) |
| Commit `fefb13a` pushed | 15:38:53 UTC. Backend only (2 files) |
| Railway backend (`fefb13a`) | **Deployed and verified** by 15:44 UTC. The Supabase edge log shows the overview's reads now run in parallel, and live timings dropped (section 17) |
| Documentation commit for the additions | Pushed after this report. Docs only |

## 26. Remaining configuration requirements

These are owner or clinic actions. The system is in a safe state without them.

1. **Service durations and species: done.** An administrator entered them at 11:14–11:15 UTC (30 minutes each,
   Puppy Cut for dogs). If 30 minutes is not each service's real length, correct it in System Management →
   Services & booking. The system does not know the clinic's real durations.
2. **Clinic contact details.** Enter phone, email, address and hours in System Management → Contact messages, so they
   appear on the Contact page and in emails. Still empty.
3. **Care reminder rules.** None exist yet. Until one does, a completed visit creates only an "Ask the clinic"
   reminder with no date. To get dated reminders, add a rule per service (and per species where needed) in System
   Management → Services & booking → Care reminder rules. The starting guidance shown there is reference material
   only, not clinic policy, and it is never applied by itself.
4. **Legacy password value.** Run `2026-10-24_remove_legacy_plaintext_password.sql`, or have that account owner use
   "Forgot password?". The owner authorized the additions migration. This file changes a customer's stored
   credential, so it waits for its own explicit permission.
5. **Optional:** on Railway, set `BREVO_SENDER_EMAIL` / `BREVO_SENDER_NAME`, then remove the `SENDGRID_*` variables.
   Not required today.
6. **Optional:** delete the stale `pethub-beige.vercel.app` deployment. It runs old frontend code and is still on the
   backend's explicit CORS list.
7. **Optional:** run `2026-10-24_optional_default_privileges.sql`, so future tables are never granted to API roles by
   default. Until then, every new migration must revoke those grants itself, as the additions migration does.

## 27. Known limitations

**Not tested live:**

- Booking, approval, cancellation and their emails, by this work. No bookable service existed during the hardening
  pass, and no test booking was made afterwards so that real records stay as they are. These were verified locally
  and in the isolated full stack.
- A multi-pet booking, a whole-booking cancel, a reschedule and a care reminder were not created in production. The
  owner test account has one pet, and making production records only to test them was avoided. They were verified in
  the isolated full stack, and against the live database functions in the rolled-back dry run. Live, the requests the
  server refuses were exercised (section 29).

**Not built (future recommendations, out of scope for this phase):**

- Opening-hours enforcement and a booking horizon.
- A cap on pending requests per account.
- Appointment reminders.
- A "log out of all devices" control.
- Logging of verification and reset emails in `email_logs`.
- An attempt counter for the email verification code.
- Registering pets under 1 year old.
- Pagination of the remaining admin lists. The breed catalog and the service activity history are paged (section 29);
  the overview, appointment and owner lists load whole, which suits the current volumes.
- Parallel appointments. The schedule allows one appointment at a time, so the pets in a multi-pet booking are seen
  one after another.
- Owner-side cancellation of a whole multi-pet booking at once. Owners cancel each pet's appointment, under the
  existing 2-hour rule; the clinic can cancel the whole booking.

**Known behaviours of what exists:**

- An email left in Pending (the server stopped mid-send) cannot be resent from the UI.
- Rate limits are kept in memory, which suits the single Railway instance.
- "Sent" means Brevo accepted the email. Delivery evidence lives in Brevo's logs, now traceable by message id.

**CSP trade-offs:**

- `style-src` allows inline styles, because a few style attributes are used.
- Google Fonts CSS can't carry SRI.
- Changing any inline script requires updating its hash. A test enforces this.
- Vercel's preview toolbar may be blocked on preview deployments. Production is unaffected.

## 28. Final capstone demonstration checklist

Before the demonstration:

- [ ] Sign in again on every demo device: earlier tokens are no longer valid.
- [ ] Check that the service durations (now 30 minutes each) are the clinic's real ones.
- [ ] To show multi-pet booking, the demo owner account needs at least two pets. The test owner account has one, so
  add a second through My Pets during the demo.
- [ ] To show a dated care reminder, add a care rule for a service first. Then mark an appointment of that service
  Completed, which is allowed once its start time has passed. Without a rule, the reminder says "Ask the clinic".
- [ ] Optional: enter the clinic's real contact details.

During the demonstration:

- [ ] **Public site:** Home → Services (honest availability) → Contact (login prompt).
- [ ] **Owner:** log in → Overview → My Pets → Appointments (history; cancel dialog if a future appointment exists) →
  Pet Health and AI assistant → Contact (send a message, see the reply).
- [ ] **Admin:** log in → Overview (live counts, charts) → Appointment Management (approve/complete rules) → System
  Management → Contact messages (open, reply, delivery status) → Services & booking (setup dialog) → Activity logs.
- [ ] **Security:** log out and show that the old session is refused. Point to the CSP header in the browser's
  developer tools, and to RLS with no API grants in Supabase.
- [ ] **Additions:**
  - Owner: Appointments → "Several pets" (summary with each pet's time) → book.
  - Admin: the booking appears grouped. Approve one pet, reschedule one, and cancel the whole booking after the
    confirmation.
  - Admin: Services & booking. Add a service (it starts switched off), page through the activity history and filter
    it, then add a care rule.
  - Admin: Breed Catalog pages.
  - Owner: Overview and My Pets → Care reminders (why, acknowledge, dismiss).
- [ ] **Explain the distinction:** contact, sessions, headers, paging and the new screens are *implemented, deployed
  and live-tested*. Booking, cancellation, multi-pet booking, rescheduling and care reminders are *implemented,
  deployed and tested in isolation*, with the live database functions dry-run. Their live refusals were tested.

| Acceptance area | Status |
| --- | --- |
| Core application (pages, login, dashboards, correct backend and database) | Pass (live) |
| Services (add, configure, switch, refuse unavailable, never delete used ones, typed history) | Pass (isolated full stack + live refusals; live services configured by an administrator) |
| Appointments (book, approve, transitions, 2 h cutoff, history, email) | Pass (local + isolated full stack). Live booking open since the services were configured |
| Multi-pet booking (atomic, per-pet management, whole-booking cancel, notifications) | Pass (local + isolated full stack + live dry run + live refusals) |
| Pagination (breeds, service activity; server-side, filters, newest first) | Pass (live) |
| Care reminders (rules, explainable, completed visits only, acknowledge/dismiss, override, no auto-booking) | Pass (local + isolated full stack + live endpoints); no rules configured yet |
| Performance (indexes, measured queries, dashboard response) | Pass (all measured queries under 13 ms; overview 1.1–1.9 s live) |
| Contact (login required, verified sender, read, reply, email) | Pass (live, delivered) |
| Security (no new plaintext, sessions, roles, ownership, keys, headers) | Pass (live). Legacy value: storage removal pending (section 8) |
| Database (migration state, no duplicates, no deletions, constraints, RLS) | Pass (live) |
| Deployment (backend, frontend, connectivity) | Pass (live) |

## 29. Additional requirements: implementation, migration and verification

This phase covered the requested additions: multi-pet booking, server-side pagination, pet care reminders, an
admin-managed service catalog, connected dashboards and performance. Existing features were not rebuilt. No clinic
policy, duration or interval was invented.

### 29.1 Multi-pet booking

**Data model.** One `appointment_groups` row represents the owner's booking. Each pet keeps its own `appointments`
row, with its own pet, service, duration, time and status, linked by `group_id` and ordered by `group_position`.
Every existing per-appointment feature therefore keeps working per pet: approval, completion, cancellation, emails,
status history and the owner's 2-hour rule. Single-pet bookings have `group_id` NULL and are unchanged.

**Booking.** The owner uses Appointments → "Several pets" and `POST /appointments/group`.

- A booking covers 2 to 6 of the owner's own pets, each with its own service.
- The clinic serves one appointment at a time, so the pets are scheduled one after another from the chosen start.
  The summary shows each pet's time before anything is sent.
- `create_appointment_group_if_available` checks every pet (owned by the account, species offered) and every service
  (switched on, same name and duration as the catalog). It runs under the same per-date locks as single bookings,
  then saves the booking and every appointment, or nothing at all.
- A repeated request with the same `request_key` (a double click or a retry) is stored once.
- If one pet's slot or choice is refused, only that pet is marked, with a suggested time where one exists. The other
  choices stay as they were.

**Management.**

- The admin's Appointment Management lists a booking's pets together under one heading.
- Each pet's appointment is approved, completed or cancelled on its own.
- `POST /admin/appointment-groups/:id/cancel` cancels every still-open appointment of the booking in one transaction,
  after a confirmation dialog. Each cancellation is recorded on that pet's appointment and in its status history.
- `PUT /admin/appointments/:id/schedule` moves one Pending or Approved appointment to a free time, under the same
  locks. The request carries what the admin's screen showed, so a change made meanwhile by another admin returns 409.
- Owners see "Pet 1 of 3 in one booking" on each appointment, and cancel each pet's appointment under the existing
  2-hour rule.

**Notifications.** Approval, cancellation and reschedule emails for a pet in a booking name all the pets in it. A
whole-booking cancel sends the usual cancellation email for each pet's appointment it cancelled; each is logged in
`email_logs` and can be resent. The reschedule email gives the old and new times. A failed email never undoes the
change.

### 29.2 Server-side pagination

**Breed catalog** (`GET /admin/breeds`):

- 20 per page, at most 50.
- Filters by species, status and name search, with four sort orders.
- The filters are kept while paging.
- A page past the end shows the last page.
- Live: 90 breeds over 5 pages; the Cat search gave 41 matches.

**Service activity history** (`GET /admin/services/activity`):

- Newest first. The dashboard shows 10 per page; the API allows at most 50.
- Filters by service, event type, administrator and clinic date range, all applied in the database.
- Live: the 15 earlier entries over 2 pages. Pages 1 and 2 contain different entries.

Both lists use `utils/pagination.js` and `js/shared/pagination.js`. Activity entries recorded before `event_type`
existed are shown honestly as "Settings changed (details were not recorded then)".

### 29.3 Pet care reminders

**Rules.** The clinic configures rules in Services & booking → Care reminder rules (`/admin/care-rules`). A rule
belongs to a service and, optionally, one species. It sets a minimum and maximum interval (1–1825 days), says whether
the guidance is general or veterinarian-approved, and carries a description and an explanation. A species-specific
rule wins over an all-species rule. PetHub ships with no rules. The starting guidance shown to staff is reference
material only, never applied by itself.

**Reminders.**

- A reminder is created only when an appointment is marked **Completed**.
- With a rule, the reminder gives a due range counted from the service date, plus the explanation.
- Without a rule, it says the clinic has not set a schedule and tells the owner to ask. No date is invented.
- There is one open reminder per source appointment. A newer one for the same pet and service supersedes the older
  one.
- Reminders appear on the owner's Overview and My Pets. Owners acknowledge or dismiss only their own reminders.
- The "Book this service" link appears only when the service is bookable. Nothing is ever booked automatically.

**Admin.** From a pet's record, an admin sees its reminders and can set the pet's next date with a reason. That
replaces the earlier reminder and is marked "Set by the clinic for this pet". Rule changes are typed entries in the
service activity history, and every reminder keeps its source, rule and explanation for audit.

### 29.4 Admin-managed service catalog

- Admins add services in Services & booking (`POST /admin/services`). A new service starts switched off unless it has
  a duration and at least one species; the database refuses "on" without them.
- Admins can edit a service or switch it on or off at any time, with no redeploy.
- A service that has appointments keeps its name, because appointments store the name. Services are never deleted,
  and the list shows how many appointments use each one.
- Every add, change, activation and deactivation is recorded with the administrator, the time, the type of change and
  what changed.

### 29.5 Connected dashboards

- **Owner Overview:** care reminders sit beside upcoming appointments.
- **My Pets:** shows each pet's reminders.
- **Appointments:** offers "One pet" and "Several pets". Each appointment of a multi-pet booking says which pets were
  booked with it.
- **Appointment Management:** groups multi-pet bookings and offers per-pet reschedule and whole-booking cancel. The
  email-delivery badges include the reschedule email.
- **Pet record:** shows the pet's reminders, with the override.
- **Services & booking:** holds the catalog, the care rules and the paged activity history.

Each screen reads the same backend data, so a change on one appears on the others on their next load.

### 29.6 Production migration

`2026-10-24_multi_pet_booking_and_care_recommendations.sql` ran through the Supabase MCP `execute_sql` tool, with the
owner's explicit authorization. The first attempt had been blocked by the permission classifier and was not worked
around.

1. **Review.** The file is additive only. It has a preflight that stops unless the database is in the expected state,
   a post-check, explicit `REVOKE`s of the API-role privileges that this project's default privileges would grant,
   and RLS on.
2. **Dry run.** The file ran on the live database without its BEGIN/COMMIT, followed by 9 behaviour checks, and ended
   with a deliberate error. The checks covered a group booking, an overlap refusal, a whole-booking cancel, a
   reschedule, the stale and conflict outcomes, and the rule and reminder constraints. Everything rolled back, and the
   database was confirmed unchanged.
3. **Apply.** One transaction, committed at 15:25:37 UTC. The SHA-256 of the executed statement in the Postgres log
   equals the file's hash, `37113ba5…45bc`, and the committed copy is byte-identical.
4. **Verify.**
   - Tables 18 → 21, indexes 43 → 54, constraints 87 → 118.
   - RLS on with 0 policies, and no `anon`/`authenticated` privilege on the new tables.
   - The new functions are executable by `postgres`/`service_role` only.
   - Rolled-back calls with named arguments matched the backend's calls.
5. **Data preserved.** Column-list hashes of every pre-existing row were identical before and after for `users`,
   `pets`, `appointments`, `pethub_service_catalog` and `activity_logs`.
6. **Order.** The new backend was first run locally against the migrated production database (23 / 23). Only then
   was the code pushed.

### 29.7 Performance

**Database.** Query plans were measured on the live database with realistic volumes: 50,000 activity rows (20,000 of
them service changes), 5,000 breeds and 10,000 care reminders. The rows were inserted in a transaction that was
rolled back.

| Query | Time |
| --- | --- |
| Activity page | 0.48 ms |
| Activity page count | 12.1 ms |
| Activity page, filtered | 0.15 ms |
| Breed page | 0.99 ms |
| Breed page count | 1.05 ms |
| Breed name search | 6.47 ms |
| Owner's reminders | 2.28 ms |
| Owner's pets for booking | 0.06 ms |

**API.** On the live API, network round trips dominate: each backend-to-database round trip costs 220–450 ms. The
admin overview's sequential reads were therefore made parallel in `fefb13a`.

| Endpoint (live, 4 runs each) | Before | After |
| --- | --- | --- |
| Admin overview | 2.6–5.8 s | 1.1–1.9 s |
| Service activity page | 1.3–2.0 s | 1.05–1.5 s |
| Admin services list | 1.0–1.9 s | 0.85–0.89 s |
| Breed page, care rules | 0.85–1.6 s | 0.85–1.3 s (unchanged code) |

### 29.8 Verification summary

The test totals are in section 22.

**Isolated full stack (10 / 10 new workflows):**

1. Admin adds a service; it starts off; the admin sets it up and turns it on; the owner can book it at once.
2. Activity history is newest first, typed, filtered and paged by the server.
3. Breed pages come from the server, with the filters kept.
4. The owner books three pets with different services, and sees each pet.
5. A busy slot marks only that pet, and the suggested time books it.
6. The admin sees the booking grouped, approves one pet, then cancels the whole booking.
7. The admin reschedules one appointment; the owner is emailed and sees the new time.
8. An admin rule plus a completed visit gives a reminder that explains why; the owner acknowledges and dismisses it,
   and books only by choice.
9. The admin sets a pet's next date from the pet record.
10. The new screens at phone width and in dark mode show no sideways scroll and no CSP or JS problems.

**Live (deployed):**

- 23 / 23 API checks: the new columns load, real paged history and breeds, the filters, the rules and reminders
  endpoints, and the refusals. The refusals cover a one-pet group, another owner's pets, owner access to admin
  actions, a backwards rule range, a service switched on without setup, and an unknown booking or appointment.
- 46 / 46 browser checks on the deployed site.
