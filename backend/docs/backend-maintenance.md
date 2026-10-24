# PetHub Backend Maintenance Notes

## Runtime Compatibility

The backend remains a CommonJS Express app started with `npm start` / `node server.js`, which keeps Railway deployment compatibility intact.

Environment variables are centralized in `config/env.js`. Railway should continue setting:

- `PORT`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY` (the service role / secret key). The backend's shared database client uses it when it is set (`config/env.js`), falling back to `SUPABASE_ANON_KEY` otherwise; a public key pasted into `SUPABASE_SERVICE_KEY` by mistake is ignored. Password reset uses it too (`config/supabaseAdmin.js`, never the anon key). At startup the log line `supabase.client_key` names the variable and the kind of key in use (never the key). It must be the service role key before row level security is switched on (`database/migrations/2026-10-20_rls_least_privilege.sql`). Server-side only: never put it in frontend code or Vercel.
- `SUPABASE_ANON_KEY` (fallback only; the browser never talks to Supabase directly)
- `BREVO_API_KEY` (Brevo transactional email API key; verification, password reset and appointment approved/cancelled emails are sent through Brevo)
- `BREVO_SENDER_EMAIL` (sender address for Brevo emails; must be a sender verified in Brevo). Deployments set up before this name existed use `SENDGRID_FROM_EMAIL`, which is still read when `BREVO_SENDER_EMAIL` is not set, so nothing has to change on Railway; set the new name when convenient and then remove the old one.
- `BREVO_SENDER_NAME` (sender display name; defaults to `PetHub`; `SENDGRID_FROM_NAME` is the legacy fallback)
- `SENDGRID_API_KEY` is not read anywhere (email goes through Brevo with `BREVO_API_KEY`) and can be deleted wherever it is set.
- `GEMINI_API_KEY`
- `GEMINI_MODEL`
- `AUTH_TOKEN_SECRET` (at least 32 random characters; signs login session tokens. Without it, login is refused. Changing it signs every user out.)

## Sessions

Each login stores a row in `user_sessions` (`database/migrations/2026-10-24_user_sessions.sql`: who, created, expires, revoked; no token, IP or device) and the signed token names that row. `middleware/requireAuth.js` checks on every signed-in request that the row belongs to the token's account, is not revoked and has not expired (8 hours, `constants/auth.js`). `POST /auth/logout` revokes the session it was sent with (other devices stay signed in until they log out); a completed password reset revokes every open session of the account. If the session table cannot be read the request gets a 503 (the browser keeps its sign-in) instead of a 401. Tokens issued before sessions existed carry no session id and are refused, so everyone signed in once more after that deployment. Apply the migration BEFORE deploying a backend with this code, otherwise every login fails.

Optional frontend origin settings:

- `FRONTEND_URL` (frontend origin; allowed by CORS and used for the My Appointments link in appointment emails, which is left out when it is not set)
- `CORS_ORIGINS` as a comma-separated list

Online payments (PayMongo deposits) were removed from PetHub. `PAYMENTS_ENABLED`, `PAYMONGO_SECRET_KEY`, `PAYMONGO_WEBHOOK_SECRET` and `PAYMONGO_API_URL` are no longer read and can be deleted wherever they are still set. The old `/payments/*` endpoints answer with the API 404. The database keeps the `payments` table and the `appointments.deposit_required` / `appointments.payment_status` columns (historical data, see `database/migrations/2026-10-17_paymongo_deposits.sql`); the application no longer reads or writes them.

## Accounts and Passwords

New passwords (registration and password reset) are stored as salted scrypt hashes by `utils/passwordHash.js` (Node's built-in `crypto`, no dependency), and only scrypt hashes ever verify. Values stored before hashing was introduced (plaintext, `sha256$...`) are no longer accepted: such an account is told at login that it needs a new password and uses "Forgot password?" (the emailed-code reset), which stores a scrypt hash. Until 2026-10-24 the first login replaced such a value. One customer account still held a plaintext value on 2026-10-24; it can no longer log in with it. `database/migrations/2026-10-24_remove_legacy_plaintext_password.sql` removes that value from storage (replaced inside the database by a random `reset-required$...` marker that matches no password; the old value is never read out). It was NOT applied: see `database/migrations/APPLIED.md`. Until it is run, or until that owner completes "Forgot password?", the old value stays in the database but is never accepted. Do not roll the backend back to a version older than the hashing change: older code compares plaintext and would refuse every account created or reset since.

Registration requires every field: full legal name, email, password and its confirmation, date of birth, gender ("Prefer not to say" is a valid answer), contact number (Philippine mobile or landline, or another country's number starting with + and its country code) and a Philippine home address (house/unit and street, barangay, city/municipality, province, 4-digit postal code). The rules are in `validators/authValidator.js` with the limits in `constants/userProfile.js`; `frontend/js/shared/profile-fields.js` repeats them for the forms and `tests/profile-fields.test.js` keeps the two in step. The details need `database/migrations/2026-10-20_users_profile_fields.sql`: apply it BEFORE deploying this backend, otherwise every registration is refused (503, nothing saved). `users.phone_number` already existed and holds the contact number.

Accounts created before the details were required keep NULL in those columns and can still log in and book. Their dashboard shows a "Complete your details" banner; the owner fills them in with `PUT /auth/profile` (signed-in owner only; every detail required; email, password, role and verification status are refused). The dashboard reads them through `GET /auth/user-status?include=profile` (owner only); admin user lists do not include them.

Roles: `PUT /admin/dashboard/user-role` accepts only `user` and `admin`, and refuses (409) to change the role of the last remaining administrator, including an administrator changing their own role, so the Admin Dashboard can never be left without an administrator. Role changes run one at a time within one backend process.

## Request Limits

`middleware/rateLimit.js` limits login, registration, email verification, verification-code resends, password reset, the chatbot (per client IP), and profile updates, booking requests and contact messages (per account); the numbers are in `constants/rateLimits.js`. `GET /admin/system-logs?limit=` returns 20 entries by default and never more than 200. Over the limit the API answers 429 with `Retry-After`. `server.js` trusts one proxy hop (Railway) so the client IP is the visitor's. The counts live in memory: they reset when the server restarts and are not shared between instances.

## Services and Scheduling

The clinic's services (Bath, Trim, Puppy Cut, Full Grooming, Nail Cutting, Face Trim, Flea and Tick Removal, Medicated Bath, Dog & Cat Full Check Up) are stored in the `pethub_service_catalog` table (created by `2026-10-23_reconcile_live_schema.sql`) and edited by administrators in the Admin Dashboard (`GET /admin/services`, `PUT /admin/services/:id`, optimistic `version` check). `constants/services.js` only holds the seed values and test fixtures; it is not read at runtime to authorize a booking. The public Services page and the booking page load the catalog from `GET /appointments/services`. Until the table exists, those endpoints answer 503 and nothing can be booked.

Durations are NOT confirmed yet: every service is seeded with no duration and online booking off, so it cannot be booked until an administrator saves a clinic-confirmed duration, at least one species and turns online booking on (the database refuses "on" without the other two). Puppy Cut is seeded with no species because its species rule awaits the clinic. Bookings and approvals go through the `create_appointment_if_available` / `update_appointment_status_if_available` database functions, which lock the date so separate backend instances cannot double-book. Earlier service names saved on existing appointments (e.g. "Checkup") cannot be booked any more but those appointments keep their saved duration and can still be approved, completed or cancelled; one saved without a duration can be approved but blocks no time. New pet profiles must be a Dog or a Cat.

In the Admin Dashboard, switching on a service that has no confirmed duration or species opens a setup dialog; "Save and turn on" stores the settings and opens the service in one `PUT /admin/services/:id`. A service that already has appointments keeps its name (appointments store the name as text), so a rename is refused with 409. An administrator can approve a request only before its start time and mark an appointment Completed only after its start time (Asia/Manila).

Cancelling (owner, at least 2 hours before the Asia/Manila start, or administrator) keeps the appointment row and records when (`appointments.cancelled_at`) and by whom (`appointments.cancelled_by`). Every status change is also written to `appointment_status_history` by a database trigger. The owner's confirmation email ("Your PetHub Appointment Has Been Cancelled") is sent before the response, so the owner is told whether it went out; a failed email never undoes the cancellation.

Administrators add services with `POST /admin/services` (a new service starts with online booking off unless a duration and species are given) and switch them on or off; a service that has appointments is never deleted. Every add, change, activation and deactivation is written to `activity_logs` with an `event_type` (`constants/serviceActivity.js`) and shown, newest first and one page at a time, by `GET /admin/services/activity?page=&page_size=&service_id=&type=&admin_id=&from=&to=`. Entries saved before `event_type` existed are listed as "Settings changed (details were not recorded then)".

## Multi-pet Bookings, Rescheduling and Care Reminders

These need `database/migrations/2026-10-24_multi_pet_booking_and_care_recommendations.sql` (applied 2026-10-24, see `database/migrations/APPLIED.md`).

- `POST /appointments/group` books 2 to 6 of the owner's own pets at once. The booking is one `appointment_groups` row and one `appointments` row per pet (`group_id`, `group_position`), placed one after another from the chosen start because the clinic serves one appointment at a time. `create_appointment_group_if_available` saves all of them or none; a repeat of the same request (same `request_key`) is stored once.
- Each pet's appointment is approved, completed or cancelled on its own as before. `POST /admin/appointment-groups/:id/cancel` cancels every still-open appointment of a booking (`cancel_appointment_group_by_clinic`), recorded on each pet's appointment and in its status history; the owner gets one email naming all the pets.
- `PUT /admin/appointments/:id/schedule` moves one Pending or Approved appointment to a free time (`reschedule_appointment_if_available`, same per-date locks). The request carries what the admin's screen showed (`expected_*`), so a change made meanwhile by another admin is refused with 409. The owner is emailed the new time.
- Care reminders are suggestions only and never book anything. They are created when an appointment is marked Completed and its service has an active rule in `care_recommendation_rules` (`/admin/care-rules`, per service and optionally per species, an interval range in days and an explanation). Without a rule nothing is suggested; no dates are invented. Owners see them on the dashboard and My Pets (`GET /pets/care-recommendations`) and can acknowledge or dismiss them; an administrator can set a pet's next date with a reason (`POST /admin/care-recommendations/:id/override`), which replaces the earlier suggestion. The reference table in `constants/careRecommendations.js` is shown to administrators as starting guidance and is not applied by itself.
- The breed catalog is paged in the database: `GET /admin/breeds?page=&page_size=&species=&status=&q=&sort=` (`utils/pagination.js`).

## Contact Messages, Emails and Clinic Details

`POST /contact` requires a signed-in account: the sender's name and email are copied from the account, never taken from the request. A repeat of the same subject and text within 10 minutes is stored once. Customers see their messages and the clinic's reply with `GET /contact/mine`. Administrators list messages, mark them read and reply once (`POST /admin/dashboard/contact-messages/:id/reply`); the reply is stored first and then emailed to the account's address.

Appointment and reply emails are recorded in `email_logs` (Pending, then Sent or Failed); a unique index allows one email of each type per appointment or message, so a retried request cannot send a second copy. A Failed email can be sent again from the Admin Dashboard (`POST /admin/email-logs/:id/retry`), once at a time. Verification and password-reset emails are not logged there.

The clinic's public phone, email, address and opening hours are stored in `system_settings` (keys `clinic.phone`, `clinic.email`, `clinic.address`, `clinic.hours`), edited in System Management > Contact messages (`GET`/`PUT /admin/clinic-settings`) and published at `GET /contact/clinic-info`. None are shipped: until the clinic enters them, the Contact page and emails point customers to the signed-in Contact form. These features need `database/migrations/2026-10-24_contact_cancellation_email_log.sql` (applied to the live project on 2026-10-24, see `database/migrations/APPLIED.md`).

## Pet Profiles

Rules for `POST /pets/create` and `PUT /pets/update/:id` are in `validators/petsValidator.js` with the values in `constants/pets.js` (repeated by `frontend/js/core/utils.js validateAge` and the My Pets form; `tests/pets-page.test.js` keeps them in step): name and species (Dog or Cat) required, breed optional, name and breed at most 50 characters, and age required as a whole number of years from 1 to 25. That range is the application's configured age-entry range, not a lifespan figure. An edit changes only the fields sent; a saved age outside the range is kept until the owner changes the age or the species.

Duplicates (`utils/petDuplicates.js`): a new or edited profile that matches another profile of the SAME owner on name and species, with a breed and age that do not contradict, is answered 409 `POSSIBLE_DUPLICATE_PET` with that owner's matching profiles and nothing is saved, until the owner sends `confirm_not_duplicate: true`. A matching name alone never counts, nothing is merged, other accounts are never compared, and there is no unique database constraint (households may have two pets with the same name). Without a stable identifier (no microchip column) the same animal registered on two accounts cannot be detected; moving a pet between accounts would need a verified ownership-transfer workflow, which does not exist.

History: `GET /pets/history/:id` returns the owner's pet with its appointments (`appointments.pet_id`, never matched by pet name) and its official medical records, newest first, and `latest_weight`: the weight of the newest record that has one, in kg (the unit of the admin form), or null. Appointments saved without a `pet_id` are only counted (`unlinked_appointment_count`) and stay on the owner's Appointments list. Owners cannot write medical records through any route.

Deleting: `DELETE /pets/delete/:id` refuses (409 `PET_HAS_HISTORY`) while any appointment or medical record points to the pet, so history is never removed and an owner cannot start over with a clean history. Profiles with history can only be removed by a reviewed, manual decision.

Not used by the application although present in the live `pets` table (seen 2026-10-21, all empty): `profile_image`, `gender`, `birthdate`, `color`, `archived_at`. `archived_at` could back an archive workflow later, but only after its meaning (hidden from booking? from admin lists? restorable?) is decided.

Read-only checks to run in the Supabase SQL Editor before relying on these rules (they change nothing):

```sql
-- What happens to appointments and medical records if a pet row is deleted (a = NO ACTION, r = RESTRICT, c = CASCADE, n = SET NULL)
SELECT conrelid::regclass AS table_name, conname, confdeltype
FROM pg_constraint
WHERE contype = 'f' AND confrelid = 'public.pets'::regclass;

-- Older appointments without a pet_id, and how many of the owner's pets share that name (0 = no match, 1 = one candidate, 2+ = ambiguous)
SELECT a.id, a.user_id, a.pet_name, a.appointment_date, a.status,
       (SELECT count(*) FROM public.pets p WHERE p.user_id = a.user_id AND lower(trim(p.name)) = lower(trim(a.pet_name))) AS same_name_pets
FROM public.appointments a
WHERE a.pet_id IS NULL
ORDER BY a.appointment_date;

-- Saved ages the current form would not accept
SELECT id, age FROM public.pets WHERE age IS NULL OR age < 1 OR age > 25;
```

## Database Migrations

Migration files in `database/migrations/` are prepared for review and run as one transaction each; nothing applies them automatically and the live project has no `supabase_migrations.schema_migrations` table. `database/migrations/APPLIED.md` is the ledger: which files were applied, when, how and with what evidence, and which must never be run (again). Each file's header describes its state when it was prepared; where it differs, the ledger is current.

## Folder Roles

- `config/`: runtime configuration and third-party client setup.
- `constants/`: shared values such as route prefixes, statuses, durations, and email timing.
- `controllers/`: thin request-to-service adapters only.
- `services/`: business rules and response payloads.
- `repositories/`: Supabase table access.
- `validators/`: request validation and normalization.
- `middleware/`: Express middleware.
- `templates/`: reusable outgoing message templates.
- `utils/`: reusable backend helpers that are not Express-specific.
- `docs/`: project backend notes.
- `logs/`: local runtime log artifacts if needed; Railway logging should stay on stdout/stderr.

## Naming

Backend JavaScript files use lower camelCase for multiword modules, matching the existing route/controller/service/repository files. New folders should use lowercase plural names when they group a module type.

## Future Feature Prep

New features such as notifications and reminders should follow the same shape:

- add constants for statuses and timing first;
- add validators for request payloads;
- add repositories for new Supabase tables;
- add services for workflow rules;
- keep controllers thin;
- place reusable email or notification copy under `templates/`.

Do not put provider-specific notification code directly in controllers.
