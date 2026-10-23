# PetHub master system audit

**Audit baseline:** 2026-10-23 (Asia/Manila)  
**Implementation and QA:** 2026-10-23. The initial repository audit was read-only; the repairs below were then implemented in the working tree. No production database, live account, deployed endpoint, email provider, Gemini request, or deployment was touched.

## 1. Architecture and current data model

PetHub is an existing static HTML site with Tailwind CSS and vanilla JavaScript under `frontend/`, an Express 5 server under `backend/`, and Supabase/PostgreSQL repositories used only by the backend. The server mounts the route groups in `backend/server.js`, injects bearer authentication through `frontend/js/core/api.js`, and serves the frontend statically. The existing email adapter is Brevo. Gemini is called from the backend through the REST `generateContent` API. Vercel/Railway configuration is present in the code, but deployed versions and secrets were not inspected.

There is no canonical baseline `CREATE TABLE` schema in the repository. The migrations and repository projections describe the application's expected schema; `backend/tests/helpers/fakeSupabase.js` models these columns for local tests. They do not prove the deployed schema or migration ledger. The application-visible relationships are:

| Table | Fields used by the application | Relationship / status |
| --- | --- | --- |
| `users` | `id`, `fullname`, `email`, password storage, role, verification/status fields; profile fields include date of birth, gender, phone and address fields | Account identity; profile fields are added by `2026-10-20_users_profile_fields.sql`. Live column state is unverified. |
| `pets` | `id`, `user_id`, `name`, `species`, `breed`, `age`, `created_at` | `user_id` scopes an owner's profiles. No DOB, sex, color, allergy, medication or photo fields are represented in the current repository projection. |
| `appointments` | `id`, `user_id`, `pet_id`, `pet_name`, `service_type`, `estimated_duration_minutes`, `appointment_date`, `appointment_time`, `status`, `handled_by`, `created_at` | Owner and pet identifiers link a booking to its owner/profile. Legacy payment fields may remain in the database but the application no longer uses payment behavior. |
| `medical_records` | `id`, `pet_id`, `record_date`, `created_at`, `created_by`, `weight`, `vaccination_status`, `treatment`, `medical_notes` | Clinic-entered records link to a pet. Current code also selects `appointment_id`; `2026-10-22_medical_record_appointment_link.sql` adds it, but its deployed state is unverified. |
| `activity_logs` | `id`, actor/user IDs, target table/ID, action, details, timestamp | Existing audit activity source. |
| Other application tables | `email_verifications`, `password_resets`, `contact_messages`; proposed breed catalog and owner-reported weight table | Migrations and repository code exist; deployed schema and RLS are unverified. |

Repository documentation says the user-profile and least-privilege RLS migrations were pending at the time of the 2026-10-22 review. Three additive migrations for the breed/owner-weight tables, appointment-to-record link, and owner cancellation RPC are prepared in the repository. None was checked against the live migration ledger during this audit. No schema migration was applied.

## 2. Findings at the initial audit (before implementation)

### Booking and service configuration

- `backend/constants/services.js` is the only service catalog. It lists nine services, with all service-specific durations and the standard duration set to `null`.
- `backend/utils/serviceCatalog.js` therefore marks every service `bookable: false`; `GET /appointments/services` returns that state, and `POST /appointments/create` returns 409 before creating an appointment.
- The admin dashboard currently reads that catalog and explains that durations/species are set in source code. It has no save control or service-configuration endpoint. No persistent service-configuration table or global booking switch exists.
- The owner page gets the catalog from the backend and blocks disabled choices. It collects date/time but the repository has no clinic-hours, capacity, lead-time, or slot-generation configuration. It checks overlap against saved appointment dates and durations; no hours or open slots are fabricated.
- Schedule overlap prevention is not atomic across customers or backend processes. The per-process keyed lock prevents duplicate submissions by one owner and serializes some admin approvals, but the booking's availability check and insert are not protected by a shared database lock/constraint. This is a real race risk if overlapping requests run concurrently or on multiple Railway instances.
- Owner cancellation is implemented with owner/status/cutoff checks in Asia/Manila and calls the conditional `cancel_appointment_for_owner` database function. The migration creating that function is present but its deployed state is unknown; the code fails closed with 503 if the RPC is missing.

### Pet profiles and official weights

- Owners create and edit only name, species (Dog/Cat), optional breed and required whole-year age (1–25), all validated by the server. Breed choices use the existing species-filtered catalog API. DOB/estimated DOB, sex, spay/neuter status, color, medical/care notes, and profile-photo upload have no storage columns/workflow in the current pet model and are not safe to add as UI-only fields.
- The owner can add separately labeled, append-only owner-reported weight entries. These are stored separately from official clinic weights, after the breed/owner-weight migration is applied. The code handles the missing table without silently treating owner reports as official.
- Official weight is read-only to owners. Only the admin medical-record route writes `medical_records.weight`; the owner medical-record write route returns 403. The latest official weight is selected from valid records by record date then creation time, with `null` for no official measurement. Existing history is retained.
- The admin medical-record workflow validates the selected pet and, for linked appointments, checks completion, owner/pet match and duplicate/unresolved history. The explicit DB appointment link is nevertheless migration-dependent.

### Public content and image provenance

- `frontend/assets/images/photos/CREDITS.md` identifies three displayed Wikimedia Commons photographs under CC BY 2.0/4.0. Attribution is currently shown in an About-page Photo Credits section and linked from footers on public/auth pages. The photographs include other businesses' staff and premises and are explicitly described as stand-ins; removing attribution while continuing to serve them would not satisfy the recorded license terms. They should be removed from the public assets and replaced by the existing PetHub paw motif / non-photo layout.
- Visible unfinished content exists in About (clinic name/story/team), Contact (phone/email/address/hours), Services (Puppy Cut species placeholder), and Privacy (draft banner, controller/purpose/retention/request/effective-date placeholders). These values cannot be replaced with invented clinic facts.
- Footer credit links repeat on Home, About, Services, Contact, Privacy, Login, Register, Verify Email and Forgot Password pages.

### Gemini assistant

- The backend uses configurable `GEMINI_MODEL`, defaulting to `gemini-2.5-flash`, via one-turn REST `generateContent`. The browser sends only the latest message and page name; conversation history is not sent to Gemini, so follow-up context is not preserved by the model.
- There is no Google Search grounding or citation extraction. The Gemini key is currently placed in the query string, provider error bodies are logged, and requests have no explicit timeout. Errors return generic HTTP 500 responses.
- Emergency phrase checks are English keyword-only and treat issues as pet emergencies. There is no specific response for a human dog bite, including the requested wound-flushing and urgent human medical assessment advice.
- The frontend escapes model text before applying a small markdown-like formatter, so model output is not directly inserted as raw HTML. It displays no returned source citations because none are requested or parsed.
- The existing AI route is rate-limited, but it is unauthenticated. The client enforces an additional keyword allowlist; its blocked terms can reject legitimate health/emergency phrasing and it does not provide Tagalog-specific support.

### API, authorization, error handling

- All declared Express route groups are mounted. The full local route-inventory test passes. No confirmed frontend path/method mismatch was found in the inspected flows.
- Owner routes use `requireAuth`; the middleware verifies the signed token and rejects supplied IDs that disagree. Owner pet/appointment/record queries are further scoped in repositories. Admin routes use the same token and re-check the user's database role. Contact is public with optional verified identity and rate limiting; AI is public and rate-limited.
- `GET /appointments/all` exposes only schedule date/time/duration/status fields to authenticated users, not owner IDs, pet names or handlers. Admins use the separate full appointment route.
- Two appointment status write routes exist (`PUT /appointments/updateStatus` and `PUT /admin/dashboard/appointment-status`) with overlapping admin-only behavior; the latter is used by the current dashboard, while tests retain the former as a compatibility route.
- Local code and mock-backed tests cannot confirm live Supabase RLS/grants, database constraints, migration application, production route registration, or secrets. The frontend API base is the configured Railway URL; local tests use an isolated mocked API.

## 3. Baseline API endpoint inventory

All paths below are mounted by `backend/server.js`. Local route tests cover route presence; the complete local suite and selected mocked-browser flows passed at baseline. “Live” means real Supabase/provider/deployed behavior, which was not tested.

| Method and path | Frontend caller | Handler / access | Validation and response/data | Baseline status / audit note |
| --- | --- | --- | --- | --- |
| `POST /auth/login`, `/auth/register`, `/auth/verify-email`, `/auth/resend-code`, `/auth/forgot-password`, `/auth/reset-password` | `js/core/auth.js`, `js/core/verify.js`, `js/core/password-reset.js` | Auth controller; public, rate-limited | Field validators; account/session or verification/reset results; `users`, verification/reset tables | Local auth tests pass; email delivery unverified live. |
| `POST /auth/logout`, `GET /auth/user-status`, `PUT /auth/profile`, `GET /auth/activity-logs` | `js/core/storage.js`, `js/admin/dashboard.js`, `js/user/dashboard.js` | Auth controller; bearer token required | Token identity checked; profile/status projections omit secrets; activity is user-scoped | Local auth/profile tests pass; profile migration state unverified. |
| `POST /pets/create`, `GET /pets/userPets`, `PUT /pets/update/:id`, `GET /pets/history/:id`, `DELETE /pets/delete/:id` | `js/user/pets.js` | Pets service; bearer owner identity | Name/species/breed/age and UUID validation; owner-scoped pet/profile/history response; pets, appointments, medical records | Local pet/ownership tests pass; supported fields are limited to current schema. |
| `GET /pets/breeds` | `js/user/pets.js` | Breed catalog controller; authenticated owner | Species and active-catalog filtering; breed catalog rows | Local and mocked-browser tests pass; migration state unverified. |
| `POST /pets/:id/weight-reports` | `js/user/pets.js` | Pets service; authenticated owner | Positive weight and pet ownership; separate owner-reported row | Local tests pass; requires the owner-weight migration. Not an official weight. |
| `GET /pets/medical-records` | `js/user/health.js` | Pets service; authenticated owner | Owner pet IDs filter official read-only records; `medical_records` | Local ownership tests pass; appointment-link column migration unverified. |
| `POST /pets/medical-records/create` | No current UI caller | Pets service; authenticated but always denied to owners | Always 403; no write | Local security tests pass; intentional guard. |
| `GET /appointments/services` | `js/user/appointments.js`, `js/admin/dashboard.js` | Appointments service; authenticated | Returns catalog name/category/description/species/duration/bookable | Local tests pass; source-code catalog only, no admin persistence. |
| `POST /appointments/create`, `GET /appointments/userAppointments`, `POST /appointments/cancel/:id` | `js/user/appointments.js` | Appointments service; authenticated owner | Owner pet, service duration/species/date/time/status/cutoff; `appointments` | Mock/local tests pass; booking blocked until durations configured; cancel requires unverified RPC migration. |
| `GET /appointments/all` | `js/user/appointments.js` | Appointments service; authenticated; reduced schedule projection | Optional date validation; returns schedule-only fields | Local tests pass; no generated slot or clinic-hours data. |
| `PUT /appointments/updateStatus` | Legacy admin appointments code/tests | Appointments service; authenticated and checks current admin role | Allowed status transition and schedule conflict; `appointments`, activity log | Compatibility route; overlapping implementation with admin route. |
| `GET /admin/dashboard/overview`, `/stats`, `/users`, `/pets`, `/appointments`, `/contact-messages`; `GET /admin/analytics/summary`, `/pet-types`, `/services`, `/appointments-trend`; `GET /admin/system-logs` | `js/admin/dashboard.js` | Admin service; token plus DB-role check | Read projections/filters; users, pets, appointments, medical records, messages, logs | Local dashboard/authorization tests pass; live access and RLS unverified. |
| `PUT /admin/dashboard/contact-message-status`, `/appointment-status`, `/user-role`; `POST /admin/dashboard/medical-records/create` | `js/admin/dashboard.js` | Admin service; token plus DB-role check | Status/role/record validators; record pet/appointment checks; appropriate table plus activity log | Local tests pass; official weights remain admin-only. |
| `GET /admin/breeds`, `POST /admin/breeds`, `PUT /admin/breeds/:id` | `js/admin/breeds.js` | Breed catalog controller; admin-only | Catalog fields and active/species/duplicate checks | Local and mocked-browser tests pass; requires breed-catalog migration. |
| `POST /contact` | `pages/public/contact.html` | Contact controller; public, optional auth, rate-limited | Name/email/message length checks; `contact_messages` | Local tests pass; no delivery claim verified. |
| `POST /ai/chat` | `js/shared/ai-widget.js` | AI controller; public, rate-limited | Message check; local FAQ/emergency or Gemini response | Local fallback tests pass; no live Gemini, grounding or citation test. |

## 4. Baseline test results

The working tree was clean before audit edits. The valid baseline was run before implementation:

- `npm test` in `backend/`: **265 passed, 0 failed** (85 suites). Browser suites are skipped unless `PETHUB_BROWSER_TESTS=1` is set.
- Mocked-browser command for admin-owner records, booking, breeds, dashboards and pets: **50 passed, 0 failed** (7 suites), including mobile-width and dark-mode checks. These use a real local headless browser but a mocked API/database.
- No live Supabase, Railway, Vercel, Brevo or Gemini integration was exercised.

## 5. Implementation plan written during the baseline audit

1. Remove public attribution links and the three CC BY stand-in photos from served pages/assets, preserving layout with existing PetHub brand visuals. Remove or rewrite placeholder sections only with facts supported by current code; do not invent clinic contact details or staff.
2. Prepare an additive service-catalog migration with the current nine entries initially disabled and durations unset. Add admin-only read/update routes, strict duration/species/booking validation, and controls to the existing admin dashboard. Keep bookings unavailable until clinic-approved values are saved.
3. Close the cross-request booking race with database-atomic conflict protection in the proposed migration; keep date/time rules and service duration sourced from persisted configuration. Do not add hours, capacity, prices, or lead-time policy without clinic input.
4. Preserve the existing pet field model and weight provenance. Do not add fields that cannot be persisted; document additional owner data as a schema decision rather than presenting fake inputs.
5. Improve Gemini safety, English/Tagalog/Taglish handling, bounded conversation context, optional Google Search grounding for relevant health questions, citations, timeouts, safe errors, and human dog-bite guidance. Keep the API key in a request header and out of logs.
6. Run unit/API and mocked-browser regression tests, then review the diff. Live migration and provider validation remain an explicit staging/release step. No commit, push, production SQL or deploy is authorized by this prompt.

## 6. Decisions required before live booking and launch

- Confirm each service's duration and which species it supports; the current data has not confirmed either policy beyond Dog/Cat as the supported species set.
- Confirm clinic hours, capacity, booking lead time or any other scheduling policy before adding those controls.
- Review the privacy information, especially controller identity, purpose and retention details; do not fabricate these values.
- Verify the actual Supabase schema, RLS/grants and migration ledger in an approved environment before using the prepared migrations. The cancellation RPC and owner weight/breed tables are already migration-dependent, and service configuration will require an additional migration.
- Use isolated staging credentials/accounts to validate deployed API, email and Gemini behavior after approval.

## 7. Implementation status and post-change QA

### Implemented in the repository

- Added persistent clinic service settings and admin routes at `GET /admin/services` and `PUT /admin/services/:id`. The public catalog endpoint now reads those saved settings. The prepared migration seeds the nine existing service names with no durations and online booking disabled; Puppy Cut has no species assigned until the clinic confirms them.
- Added service edit forms to System Management. A service can only open for online booking when the admin supplies a valid duration, at least one applicable species and enables booking. Owners see the same current catalog, species rules and per-service booking state in the public Services and appointment pages.
- Replaced appointment inserts and approvals with database RPCs that serialize overlapping schedule writes across backend instances. The booking RPC rechecks the catalog and pet owner/species inside the transaction and returns only an outcome and appointment ID. Existing service durations remain attached to their appointment rows.
- Made the public Services page render the saved catalog instead of a fixed list, removed the three credited stock photographs and attribution links, and removed clinic profile/contact placeholders without inventing replacement details. The privacy page now describes observed data flows and identifies the clinic-specific details still requiring approval; it is not presented as a completed clinic privacy notice.
- Updated the AI route to use a request header for its Gemini key, bound request history and provider time, request Search grounding for current/relevant health questions, return filtered source links, and avoid logging provider response bodies or secrets. Added deterministic English and Tagalog human animal-bite guidance with the WHO source. Provider calls remain mocked in tests.

### Post-change QA

- Backend: **273 passed, 0 failed** across 87 suites (`npm test -- --test-concurrency=1`).
- Headless browser: **90 passed, 0 failed** across 11 suites, with mocked APIs and test-only data. Coverage includes public pages, responsive layouts, booking, owner/admin dashboards, catalog editing, records and sign-in flows.
- JavaScript syntax checks for changed runtime and test files passed. `git diff --check` returned success; Git reported expected LF/CRLF normalization warnings for the working tree.
- These results validate local behavior against fake Supabase/browser responses. They do not validate PostgreSQL execution, live RLS/grants, migration ordering, production data, network access to Gemini, email delivery, or deployed services.

### Still pending

- `backend/database/migrations/2026-10-23_service_catalog_and_atomic_booking.sql` is prepared but **not applied**. The repository does not contain the canonical live schema or migration ledger. Before staging use, verify the appointment/pet column types, function signatures, grants and migration state; then exercise concurrent bookings and approvals with isolated staging data.
- All nine services remain unbookable until the clinic provides approved durations and species rules. No clinic hours, capacity, prices, address, phone number or lead-time policy were added. The app intentionally fails closed if the catalog migration is missing.
- The clinic must provide its legal/controller identity, purposes, retention periods and privacy-request process before the privacy page can serve as its complete notice.
- No deploy, commit, push, provider integration call or production SQL execution was performed.
