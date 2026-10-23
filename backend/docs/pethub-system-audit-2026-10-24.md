# PetHub system dry run, audit, repair and verification (2026-10-24)

**Scope:** two master-prompt passes on 2026-10-24 (audit and repair, then a full dry run) for the capstone
"A Web Portal for Pet Status Tracking and Service Scheduling".
**Starting point:** commit `90cf2aa` on `main`, working tree clean. Earlier audits are in this folder (2026-10-22,
2026-10-23); their claims were re-verified here rather than repeated.
**Nothing was committed, pushed, deployed, or written to the production database.**

## A. Executive summary

**Original condition.**

- The code was in good shape: 280/280 unit and API tests, and the browser suites green when run serially. Every
  frontend API call reaches a mounted backend route.
- Production was **not working correctly**, because of the database, not the code. Railway runs the current backend,
  but the live Supabase database (re-verified read-only today) lacks every schema change from 2026-10-20 to 2026-10-23.
  Registration, the public Services page, booking, admin approval, owner cancellation, owner health records and the
  breed catalog fail in production.
- Row Level Security is off on all 14 tables, and the public API roles hold every privilege on them.

**Database changes were blocked, not skipped.** The connected Supabase MCP is read-only: role
`supabase_read_only_user`, `transaction_read_only = on`, and no migration tool. As instructed, it was not bypassed, so
no live database change was applied. The prepared reconciliation script's own preflight was run against the live
database twice today and passes. The owner can apply it as written (section F).

**Repaired and tested:**

- Unreadable medical records were shown to clinic staff and owners as "0 records" and "no weight". The admin was
  offered "Add Medical Record" without the records being checked. These now show as unavailable, and adding is blocked.
- API requests had no timeout. They now fail after 30 s with a clear message.
- 1,514 lines of unreferenced admin scripts were removed.
- 5 backend dependency advisories were cleared (1 critical, 2 high), using releases at least 27 days old.
- The Breed Catalog no longer turns a stored `javascript:` address into a clickable "Source" link.
- Two flaky tests were stabilized, and 14 regression tests were added.

**Final results:**

- 291/291 unit and API tests, and 384/384 in the full browser-enabled run.
- 120/120 clean page states (20 pages × 3 widths × 2 themes).
- An interaction dry run clicked every visible button on a fresh page load, with hostile HTML stored in every
  user-editable field (section D).
- Live checks:
  - the real backend starts with the local configuration and reaches Supabase;
  - live Gemini answers, and its Search grounding returns sources;
  - live data integrity is clean.

**Readiness: Not ready — critical issues remain** (section O). The code is ready for staging validation once the two
prepared SQL files are applied.

## B. Initial baseline

| Check | Command / method | Result |
| --- | --- | --- |
| Syntax | `node --check` on every backend and frontend JS file (136) | 136/136 parse |
| Unit and API tests | `cd backend; npm test` | 280/280 pass |
| Full run with browser suites | `PETHUB_BROWSER_TESTS=1 npm test` (parallel) | 369 pass, 2 fail. Both pass when re-run serially (24/24): a test race and a Windows `EPERM` on temp-folder cleanup. |
| Dependencies | `npm ls`, `npm audit --omit=dev` (backend) | `multer` declared but never used. 5 advisories: proxy-addr (critical), multer (high), ws (high), qs (moderate), body-parser (low). Extraneous leftover packages in local `node_modules`. |
| Frontend dev tooling | `npm audit` (frontend) | Advisories in tailwind/postcss build tools (dev only, not deployed) |
| Build | `npm run dev` (frontend) is the only script: a Tailwind watch. There is no lint or build step; `style.css` is committed. | n/a |
| Live database | Read-only SQL via MCP | Schema behind code; RLS off (section F) |
| Live backend | Read-only GETs to Railway | `/appointments/services` → 503 |
| Test accounts | — | **Not usable.** Neither prompt contains the passwords it refers to, and the only database is production. |

## C. Audit register

Severity: P0 critical, P1 high, P2 medium, P3 low. "Verified" names the evidence.

| ID | Sev | Component / location | Reproduction → actual (expected) | Root cause | Correction | Status / verification |
| --- | --- | --- | --- | --- | --- | --- |
| DB-01 | P0 | Supabase, all 14 `public` tables | Public key → can read and change any row, including `users.password` and reset tokens (expected: no access) | RLS never enabled; `anon`/`authenticated` granted all privileges | `2026-10-20_rls_least_privilege.sql` | **Blocked**: MCP read-only. Advisor `rls_disabled_in_public` ×14. |
| DB-02 | P0 | Live schema vs deployed code | Register → 503; Services/booking → 503; approve → 503; owner cancel → 503; owner health → 500; breed add → 503 (expected: work) | 10-20 to 10-23 migrations never applied | `2026-10-23_reconcile_live_schema.sql` | **Blocked**. Preflight passes live (twice today). Log errors and the 503 reproduced. |
| APP-01 | P1 | `adminService.getDashboardOverview`, `petsService.getUserPets`, admin and owner UI | Medical-records query fails → UI shows "0 records" / "No weight recorded yet"; "Add Medical Record" offered (expected: unavailable, no add) | Error caught and replaced by `[]`/`0` | `medicalRecordsAvailable` / `medical_records_available` flags, `'unavailable'` link state, UI guards | **Fixed**. 4 API + 2 browser tests; fail on old code. |
| SEC-01 | P1 | `backend/package-lock.json` | `npm audit`: 5 advisories (expected: none) | Old transitive versions; unused `multer` | Remove `multer`; pin body-parser 2.3.0, qs 6.16.0, proxy-addr 2.0.8, ws 8.22.0 (all ≥27 days old), `npm ci` | **Fixed**. `npm audit` 0; all suites pass. |
| SEC-02 | P1 | `users.password` (2 rows) | Aggregate count of non-scrypt values = 2 (expected: 0) | Accounts created before hashing | Rehash on next login (already in code), and DB-01 | Open. No values read. |
| APP-02 | P1 | Breed catalog "API endpoint not found" | Admin → Breed Catalog showed it (expected: catalog) | (1) Railway ran a build older than `bff5696`, which added `/admin/breeds`; that text comes only from Express `apiNotFoundHandler`. (2) Table `pet_breed_catalog` missing. | (1) Resolved by deployment: Railway has requested `pet_breed_catalog` since 2026-10-23 05:21Z. (2) Reconcile PART C. | (1) Verified in logs. (2) Blocked with DB-02. The UI now shows "not available until its database update is applied". |
| SEC-03 | P2 | `frontend/js/admin/breeds.js` | Breed row stored with `source_url = 'javascript:…'` (directly in the database) → Breed Catalog shows a clickable "Source" that runs it (expected: no link) | Rendered after HTML escaping only; escaping does not neutralize a URL scheme. The API validator already allows only http(s); the column has no constraint. | Render a link only for http(s) URLs (same rule as the API and the AI source links) | **Fixed**. Found by the interaction dry run. 1 browser test; fails on old code. |
| APP-03 | P2 | `frontend/js/core/api.js` | Hung backend → page stays "Loading" (expected: clear failure) | No timeout on any request | 30 s `AbortSignal.timeout` in the shared wrapper; separate message for changes | **Fixed**. 5 vm tests; 2 fail on old code. |
| QA-01 | P2 | `register-page.browser.test.js`, browser teardown | Parallel run fails intermittently (expected: deterministic) | Request read after the page navigated; `rmSync` `EPERM` on a locked temp profile | Mocked reply held 2 s; best-effort cleanup in 3 places | **Fixed**. Full parallel run green twice. |
| QA-02 | P2 | Password-reset lockout and expiry | No repo test covered them | Earlier tests lived only in a scratchpad | 2 regression tests | **Added**. The lockout test fails when the lockout is removed. Expiry is enforced in three places; the test fails when all are removed. |
| DB-03 | P2 | `appointments.status`, `medical_records.weight`, `contact_messages.status` | No CHECK constraints (expected: database-level guard) | Never created | Recommendation N-5 (after DB-01) | Open. Live data already complies. |
| DB-04 | P2 | FKs `pets_user_fk`, `medical_records_pet_fk`, `appointments_user_fk` | Deleting a user cascades to official records | ON DELETE CASCADE | Clinic decision (`RESTRICT` for clinical data) | Open. No delete feature exists. |
| BIZ-01 | P2 | Booking rules | Once a service is opened, any time of day is requestable | No hours, lead time or capacity configured | Recommendation N-2; clinic must supply values | Open (no invented hours) |
| CODE-01 | P3 | `frontend/js/admin/{appointments,pets,users,sidebar}.js` | No page loads them | Left behind by the 10-21 dashboard restructure | Deleted; the 10-23 inventory doc corrected | **Fixed**. All pages crawl clean. |
| API-01 | P3 | 9 routes with no frontend caller: `GET /admin/dashboard/{stats,users,pets,appointments}`, `GET /admin/analytics/*` (4), `PUT /appointments/updateStatus` | — | Superseded by `/admin/dashboard/overview` and `/admin/dashboard/appointment-status` | Kept. All are authenticated and admin-checked, and covered by tests. `updateStatus` removal was previously declined. | Reported |
| CFG-01 | P3 | CORS | Disallowed origin → 500 (expected 403); any `*.vercel.app` or `localhost` origin allowed | `cors` error goes to the 500 handler | Previously declined by the owner | Reported. Low impact: bearer tokens, no cookies. |
| CFG-02 | P3 | Frontend dev tooling advisories | `npm audit` in `frontend/` | tailwind/postcss chain | Not changed: dev-only, and an upgrade could change compiled CSS | Reported |
| PERF-01 | P3 | Admin overview | Reads whole tables plus up to 5,000 log rows per load | Simple design | Recommendation N-8 when data grows | Reported (5 accounts today) |
| BIZ-02 | P3 | Completion before the visit date | An Approved future visit can be marked Completed (two clicks) | No date rule | Clinic policy decision (N-7) | Reported |

Re-checked with no defect found:

- owner isolation (identity comes only from the signed token; repositories filter by owner);
- admin role re-read from the database on every admin request;
- last-admin guard;
- no Supabase key in `frontend/`;
- logs carry no passwords, codes or tokens;
- error replies hide internals (`errorHandler`; invalid JSON → 400);
- JSON body limit is the Express default (100 kB);
- the status vocabulary (Pending/Approved/Completed/Cancelled) matches across UI, API and data.

## D. Frontend results

- **Pages:** 9 public and auth pages, 4 owner pages, 4 admin dashboard sections, the Breed Catalog, and 3 redirect
  stubs. Every image has `alt` text, and all 11 forms have a submit handler.
- **Load-state crawl** (real Express app and frontend, fake in-memory database, real headless Chrome, at 1280, 768 and
  375 px in light and dark): 120/120 page states with no JS exceptions, console errors, failed API calls, horizontal
  overflow, broken images, unlabeled controls, "undefined/NaN" text or endless spinners. A non-admin opening the admin
  dashboard is sent to their own dashboard.
- **Interaction dry run** (same setup, run at 1280 px and at 375 px):
  - **Method:**
    - every visible, enabled button on every page state was clicked on a fresh page load, up to 80 per page; the
      Breed Catalog has 184;
    - a click counted as working if it changed the DOM, sent a request, navigated or moved focus;
    - every internal link was checked against the files on disk, and same-page anchors against element ids;
    - hostile HTML (`"'><img src=x onerror=…>`) was stored in every user-editable field: owner names, addresses,
      pet names and breeds, service names, record fields, contact messages, logs and breed entries.
  - **Results:**
    - 177 clicks at 1280 px and 186 at 375 px (including the mobile menu toggles): **0 controls with no effect**;
    - **0 script executions** from the stored HTML, **0 JS exceptions**, **0 duplicate API requests** on load;
    - one real problem, SEC-03 (now fixed).
  - **Not a problem:** "Log out" is `href="#logout"`, handled by a delegated listener (`main.js`), and it works.
- **Changed:** admin dashboard and My Pets "unavailable" states; the shared API timeout; the Breed Catalog source-link
  check; 4 dead admin scripts removed.
- **Unresolved:** CSS used only by the removed scripts remains (N-9).

## E. Backend results

- **Routes:** 47 routes in 6 groups, all mounted; every frontend call maps to one (inventory below). Protected groups
  use `requireAuth` (signed HMAC token, 8 h). `/admin/*` adds a database role check. Public routes (login, register,
  verify, reset, contact, AI) are rate-limited.
- **Changed:** `adminService` (records availability and `null` totals), `petsService` (records availability),
  `package.json` and `package-lock.json` (dependencies).
- **Started for real** (`npm start`, local `.env`, Stage B):
  - the Supabase key is recognized as `service_role`;
  - no missing-configuration warnings (e-mail, AI, token secret);
  - static pages served; `/appointments/services` 503 from the live database (same as Railway);
  - protected routes 401; invalid JSON 400; unknown API route 404.

| Area | Endpoints | Frontend caller |
| --- | --- | --- |
| Auth | `POST /auth/login, register, verify-email, resend-code, forgot-password, reset-password, logout`; `GET /auth/user-status, activity-logs`; `PUT /auth/profile` | `core/auth.js`, `core/verify.js`, `core/password-reset.js`, `core/storage.js`, `user/dashboard.js`, `admin/dashboard.js` |
| Pets | `POST /pets/create, /pets/:id/weight-reports`; `GET /pets/userPets, breeds, history/:id, medical-records`; `PUT /pets/update/:id`; `DELETE /pets/delete/:id`; `POST /pets/medical-records/create` (always 403) | `user/pets.js`, `user/health.js`, `user/appointments.js`, `user/dashboard.js` |
| Appointments | `GET /appointments/services` (public), `userAppointments`, `all`; `POST create, cancel/:id`; `PUT updateStatus` (no caller) | `user/appointments.js`, `public/services.js`, `shared/appointment-durations.js`, `user/dashboard.js` |
| Admin | `GET/PUT /admin/services`; `GET/POST/PUT /admin/breeds`; `GET /admin/dashboard/overview, contact-messages`; `PUT appointment-status, contact-message-status, user-role`; `POST medical-records/create`; `GET /admin/system-logs`. No caller: `stats`, `users`, `pets`, `appointments`, `analytics/*` | `admin/dashboard.js`, `admin/breeds.js` |
| Other | `POST /contact`, `POST /ai/chat` | `pages/public/contact.html`, `shared/ai-widget.js`, `user/health.js` |

## F. Database results

**Access:** Supabase MCP `execute_sql` as `supabase_read_only_user` with `transaction_read_only = on`; no
`apply_migration`. **No live change was applied.** Only catalog metadata and aggregate counts were read; no passwords,
codes, e-mails or row contents.

**Live schema (2026-10-24):**

- PostgreSQL 17.6, time zone UTC. Appointment `date` and `time` are clinic wall-clock values, read as Asia/Manila.
- 14 tables, no migration ledger, 0 functions, 0 policies, RLS off, no CHECK constraints on core tables.
- Missing: `users` profile columns, `medical_records.appointment_id`, `pethub_service_catalog`, `pet_breed_catalog`,
  `owner_pet_weight_reports`, 3 appointment functions, and the one-open-reset-code index.
- Present but unused by the app: `payments` (1 legacy row), plus 5 empty tables: `notifications`,
  `appointment_status_history`, `email_logs`, `reminder_logs`, `system_settings`.

**Relationships:**

| Delete rule | Foreign keys |
| --- | --- |
| CASCADE | `pets.user_id`, `appointments.user_id`, `email_verifications.user_id`, `password_resets.user_id` → users; `medical_records.pet_id` → pets |
| SET NULL | `appointments.pet_id` → pets; `appointments.handled_by`, `medical_records.created_by`, `activity_logs.actor_id`/`user_id` → users |

**Data integrity (read-only, counts only): every check is 0.** Checked:

- pets, appointments, records, verifications and resets without a parent;
- appointments whose pet belongs to another owner, or whose pet name differs from the pet;
- invalid statuses, missing or out-of-range durations, handlers who are not admins;
- `cancelled_at` disagreeing with status, duplicate open slots, past appointments still open;
- record weights ≤ 0, duplicate e-mails (case-insensitive), invalid roles, deleted users;
- same-owner duplicate pets, expired open verifications, log rows without an actor.

Current data: 5 users (1 admin), 3 pets (all Dog), 2 appointments (both Completed, legacy service name "Checkup", which
the code treats as an earlier service), 0 medical records, 0 contact messages. **No data correction was needed or
made.**

| SQL file | Live status | Action |
| --- | --- | --- |
| `2026-10-23_reconcile_live_schema.sql` | Not applied; preflight passes | **Step 1** |
| `2026-10-20_rls_least_privilege.sql` | Not applied | **Step 2**, after the step 1 smoke test |
| Other 10-17 to 10-23 files | Partial or superseded | Do not run individually |

**How the owner can apply them.** Either:

- **Option 1:** follow `live-database-reconciliation-2026-10-23.md`: SQL Editor, paste the whole reconcile file, run
  once, smoke test, then RLS PART 1 checks and PART 2.
- **Option 2:** remove `read_only=true` from the Supabase MCP entry in `~/.claude.json`, reload VS Code, re-authenticate
  with `/mcp`, and ask Claude to apply and verify them.

**Recovery:**

- The reconcile file is one transaction with in-transaction pre- and post-checks; a failure changes nothing.
- After it succeeds, prefer forward fixes. Do not drop the new objects once data is in them.
- For RLS, never disable it as a rollback: fix the Railway `SUPABASE_SERVICE_KEY` instead.

## G. User dashboard results

| Workflow | Local (post-migration schema, fake DB) | Production today |
| --- | --- | --- |
| Register, verify, log in, log out, reset password | Pass (API and browser tests, including lockout and expiry) | **Registration fails** (profile columns). Login works for existing accounts. |
| Overview (pets, upcoming visits, activity) | Pass, real counts | Loads |
| My Pets: list, add, edit, duplicate warning, delete guard, owner weights | Pass | List loads; records now "unavailable"; **adding a listed breed fails**; history 500 |
| Booking | Fails closed until the clinic sets durations and species (by design) | **503** |
| Appointment list and statuses | Pass | Loads |
| Cancellation (≥ 2 h, Asia/Manila, boundary and concurrency tests) | Pass | **503** (function missing) |
| Health records (read-only, separate from AI) | Pass | **500** |
| Responsive, dark mode | Pass (crawl and tests) | Not tested live |

## H. Admin dashboard results

| Workflow | Local | Production today |
| --- | --- | --- |
| Overview metrics (owners, pets, appointments, pending, awaiting outcome, unread) | Pass, computed from real rows | Loads; records "unavailable" |
| Appointment management: approve, complete, cancel, filters | Pass (atomic overlap check on approve; invalid transitions refused) | **Approve 503**; complete and cancel work |
| Pet Owners & Records: search, owner, pet, history | Pass | Loads |
| Official medical record create (one per completed visit) | Pass | Fails (missing column); "Add" now hidden while records are unreadable |
| Service settings | Pass | **503** |
| Breed catalog | Pass | **503** |
| Users and roles (last-admin guard), contact messages, activity log | Pass | Loads |

## I. Integration results

| Integration | Method | Result |
| --- | --- | --- |
| API ↔ frontend | Static inventory, mocked browser tests, crawls | All calls resolve. Dead routes listed (API-01). |
| Supabase | Real backend started locally against the live project; MCP read-only SQL | Connects with `service_role`. Schema gap reproduced. |
| Gemini (**live**) | 2 generic questions through the real local backend | `200` in 3.6 s, cautious general answer, not grounded. A "current recalls" question returned `200` in 6.8 s, `grounded: true`, 5 cited sources. The 10-23 `google_search` grounding change is verified live. |
| Brevo e-mail | Fake provider in tests only | **Not tested live**: it would send a real e-mail and write a reset row to production |
| Deployment | Railway (live GETs); repository | Railway runs current code. Vercel and Railway settings were not accessed. No `vercel.json` or Railway config is tracked; the frontend API URL is hard-coded to Railway. |

## J. Security results

| Area | Finding |
| --- | --- |
| Authentication | HMAC-SHA256 token with timing-safe check and 8 h expiry; scrypt hashing for new passwords; rehash-on-login for legacy ones (2 remain). |
| Session limits | Logout clears the browser session, but a copied token stays valid until it expires (stateless design, known). |
| Authorization | Identity only from the token. A mismatched `user_id` gets 403. Admin role re-read from the database every request. Records are admin-write only (owner route always 403). |
| Isolation | Repository queries filter by the token owner (existing cross-owner tests pass). |
| XSS | Hostile HTML stored in every user-editable field never executed during the interaction dry run (D). A stored `javascript:` source link in the Breed Catalog was made clickable; now fixed (SEC-03). All other data-built links use a fixed path with an encoded ID, and AI source links already allowed only https. |
| Secrets | Not in `frontend/` or git; startup logs print variable names only. |
| Rate limits | Per-IP for public routes; per process. |
| **Unresolved** | DB-01 (RLS off) and SEC-02 (legacy passwords readable through DB-01). |

## K. Research and workflow alignment

PetHub fits the title when "pet status" means **appointment status tracking** plus **clinic-entered health records**.
Owner reports and the AI assistant are kept apart from official records. It does not claim GPS, wearables or
diagnosis.

Gaps:

1. In production, scheduling and records are blocked by DB-02.
2. Online booking stays closed until the clinic provides service durations and species.
3. There are no clinic hours, lead time or reminders, which every reference platform below treats as core.
4. Vaccination status is free text with no due date, so nothing can show what is due next.

**Research.** VetDeck could not be found under that name, so VetAssist (a Philippine-listed product) is used. Vendor
marketing claims were not independently verified.

| Source | Observed pattern | PetHub today | Smallest improvement | Complexity / priority |
| --- | --- | --- | --- | --- |
| ezyVet online portal ([video page](https://www.ezyvet.com/video/online-portal-for-pet-owners), [configuration webinar](https://www.ezyvet.com/webinar/online-portal); official, read through search summaries) | Owner dashboard with upcoming visits and pet profiles; clinic sets bookable services, dates/times, minimum lead time, daily caps | Dashboard and per-service switches: yes. Hours, lead time, caps: no. | Admin-set opening hours and lead time, enforced in the booking function | Medium / Next |
| Vetspire manual, Online Booking ([manual](https://manual.vetspire.com/vetspire-user-manual/ok/Commercial/online-booking); official; direct fetch 404, read through search summary) | "# of Hours Before Booking Allowed" (default 1 h); bookings land on the schedule | Only "not in the past" | Lead-time setting | Low–Medium / Next |
| Shepherd dashboard ([official page](https://www.shepherd.vet/clinical-tools/intuitive-dashboard/), read) | Whiteboard per patient (check-in, location, staff, reason), grouped by status | Overview "today and upcoming" plus filters: partly | None needed; a "today by status" view later | Low / Later |
| Covetrus Pulse with Comms ([official page](https://software.covetrus.com/veterinary-solutions/rapport-veterinary-communication-software); marketing) | Booking within set availability; automated reminders linked to confirm or reschedule | E-mail on approve/cancel only | Day-before reminder using the existing empty `reminder_logs` | Medium / Next |
| VetAssist ([Capterra SG](https://www.capterra.com.sg/software/1081710/VetAssist); third-party) | Separate clinic and customer portals | Same split | None | — |
| PetDesk for Vetspire ([vendor page](https://petdesk.com/vetspire)) | Appointment requests reviewed by staff | Pending → Approved: yes | None | — |

**Dependency matrix** (feature → UI → API → database → tests):

| Feature | UI | API | Tables / functions | Tests | Live |
| --- | --- | --- | --- | --- | --- |
| Registration and verification | `auth/register.html`, `core/auth.js`, `auth/verify-email.html`, `core/verify.js` | `/auth/register`, `verify-email`, `resend-code` | users (+ profile columns), email_verifications | registration, register-page (+browser), registration-before-migration | Fails |
| Login, session, logout | `auth/login.html`, `core/auth.js`, `core/storage.js`, `core/api.js` | `/auth/login`, `logout`, `user-status` | users, activity_logs | security, dashboard-access, rate-limits, api-timeout | Works |
| Password reset | `auth/forgot-password.html`, `core/password-reset.js` | `/auth/forgot-password`, `reset-password` | password_resets, users | regression (incl. lockout and expiry), rate-limits, public-site browser | Works (index missing) |
| Profile details | `user/dashboard.html`, `shared/profile-fields.js` | `GET /auth/user-status?include=profile`, `PUT /auth/profile` | users (profile columns) | profile-fields, profile-update | Fails |
| Pet profiles | `user/pets.html`, `user/pets.js` | `/pets/create`, `userPets`, `update`, `history`, `delete`, `breeds`, `:id/weight-reports` | pets, pet_breed_catalog, owner_pet_weight_reports, appointments, medical_records | pet-profiles, pets-page (+browser), breed-catalog, medical-records-unavailable | Partial |
| Service catalog | `public/services.html`, admin `#system` | `GET /appointments/services`, `/admin/services` | pethub_service_catalog | service-configuration, services | Fails |
| Booking | `user/appointments.html`, `user/appointments.js` | `/appointments/services`, `all`, `create` | appointments, pets, catalog, `create_appointment_if_available()` | appointments, services-booking, appointments-concurrency, booking-page (+browser) | Fails |
| Status tracking (owner) | `user/appointments.js`, `user/dashboard.js` | `/appointments/userAppointments` | appointments | appointments-order, dashboards | Works |
| Owner cancellation | `user/appointments.js` | `POST /appointments/cancel/:id` | `cancel_appointment_for_owner()` | appointment-cancellation | Fails |
| Admin appointment management | `admin/dashboard.js #appointments` | `/admin/dashboard/overview`, `appointment-status` | appointments, `update_appointment_status_if_available()` | appointments-concurrency, appointment-notifications, dashboards browser | Approve fails |
| Owners and official records | `admin/dashboard.js #records` | overview, `medical-records/create` | users, pets, appointments, medical_records (+ `appointment_id`) | admin-owner-records, admin-owners browser, medical-records-unavailable | Create fails |
| Owner health records | `user/health.html`, `user/health.js` | `/pets/medical-records` | medical_records | dashboards browser | Fails (500) |
| Breed catalog admin | `admin/breeds.html`, `admin/breeds.js` | `/admin/breeds` | pet_breed_catalog | breed-catalog (+browser) | Fails |
| Users, messages, logs | `admin/dashboard.js #system`, `public/contact.html` | `user-role`, `contact-messages`, `contact-message-status`, `/contact`, `/admin/system-logs`, `/auth/activity-logs` | users, contact_messages, activity_logs | admin-owner-records, dashboard-access, security, regression | Works |
| AI assistant | `shared/ai-widget.js`, `user/health.js` | `POST /ai/chat` | none (Gemini) | ai-grounding, regression | Works (live-verified) |
| E-mail | backend `utils/email.js` | via register, reset, approval, cancellation | — | appointment-notifications, registration (fake Brevo) | Not tested live |

## L. Test summary

| Kind | Evidence | Result |
| --- | --- | --- |
| Static | `node --check` on 136 JS files; `npm audit`; `npm ls` | All parse. Backend 0 advisories after the fix. |
| Unit, API and integration (real Express app, in-memory fake Supabase, fake Brevo; **mocked**) | `cd backend; npm test` | Baseline 280/280 → **291/291** |
| Browser (headless Chrome, **mocked API**) | `PETHUB_BROWSER_TESTS=1 npm test` (parallel) | Baseline 369 pass, 2 flaky → **384/384** (parallel runs green twice) |
| Regression proof | Old code restored temporarily | New tests fail on old code (records API 4/4, records browser 2/2, breed link 1/1, timeout 2/5; the other 3 are compatibility checks). Reset lockout and expiry mutations detected. |
| Crawls (real app and browser, fake DB) | Scratch tools | 120/120 clean load states; 363 button clicks at two widths, 0 no-effect, 0 script executions (D) |
| Database (live, **read-only**) | MCP SQL | Schema, constraints, FKs, integrity: section F. Reconcile preflight passes. |
| Live services | Real backend started locally; Railway GETs | Supabase connect: yes. Gemini: 2 requests passed (one grounded). Brevo: not tested. Live login: not possible (no passwords). |

## M. Remaining issues

| Issue | Sev | Cause | Impact | Next action |
| --- | --- | --- | --- | --- |
| DB-02 schema gap | P0 | Migrations not applied; MCP read-only | Registration, booking, approvals, records, breeds fail in production | Apply the reconcile file (F) |
| DB-01 RLS off | P0 | Not applied | Public-key read and write of all data | Apply the RLS file after step 1 |
| Booking closed | P1 | No clinic-confirmed durations or species | No online booking | Clinic enters them under System Management → Services |
| SEC-02 legacy passwords | P1 | Older accounts | Readable through DB-01 | DB-01; optionally ask the 2 owners to reset |
| Deploy | P1 | Changes are local | Production keeps old behavior | Commit, then deploy Railway (backend and lockfile) and Vercel (either order) |
| E-mail and owner/admin login unverified live | P2 | No sandbox; no passwords supplied | Delivery unproven | Clinic-controlled test accounts in staging, or a Brevo test sender |
| DB-03, DB-04, BIZ-01, BIZ-02, CFG-01, CFG-02, PERF-01, API-01 | P2/P3 | See C | See C | See N |

## N. Additional recommendations (ranked)

| # | Proposal | Benefit | Complexity | Priority | Needed for title? | Implications |
| --- | --- | --- | --- | --- | --- | --- |
| N-1 | Apply reconcile then RLS; smoke test with clinic-controlled accounts | Restores core workflows; closes data exposure | Low | **Now** | Yes | Backup first; runbook |
| N-2 | Admin-set weekly hours and minimum lead time, enforced in `create_appointment_if_available` | Owners request only serviceable times | Medium | Next (before opening booking) | Yes | New columns or table; no invented hours |
| N-3 | Optional `next_due_date` on official records, plus a "due soon" list | Real status tracking of what is due | Medium | Next | Strongly supports it | Additive column; clinic-entered only |
| N-4 | Day-before e-mail reminder for Approved visits, logged in `reminder_logs` | Fewer no-shows | Medium | Next | No | Scheduler or admin button; de-duplicate per appointment |
| N-5 | CHECK constraints: appointment status set, record weight > 0, message status set | Database-level guard on the state machine | Low | Next (after N-1) | No | Live data already complies |
| N-6 | Owner reschedule (cancel and rebook atomically) | Fewer cancellations | Medium | Later | No | New function; same cutoff |
| N-7 | Refuse Completed before the visit's clinic date, if the clinic agrees | Prevents accidental terminal states | Low | Later | No | Policy first |
| N-8 | Paginate admin lists and logs when rows reach the hundreds | Faster admin load | Medium | Later | No | API and UI changes |
| N-9 | Remove CSS used only by the deleted admin scripts and rebuild `style.css` | Smaller, clearer CSS | Low | Later | No | Visual regression check |
| N-10 | Remove the 9 uncalled routes after the owner agrees | Smaller API surface | Low | Later | No | Update the tests that cover them |

## O. Final readiness status

**Not ready — critical issues remain.**

- Production exposes every table through the public key (DB-01).
- Production lacks the schema the deployed code needs (DB-02), so registration, booking, approvals and records fail.
- Both fixes are prepared and preflight-checked against the live database, but only the project owner can apply them
  with the access available.
- The code passed every automated, crawl and interaction check run here, and the live Gemini path works.

After N-1 and the clinic's service durations, the system is **ready for staging validation**. After a clinic-account
smoke test of the owner and admin workflows, it is ready for a **controlled demonstration**.
