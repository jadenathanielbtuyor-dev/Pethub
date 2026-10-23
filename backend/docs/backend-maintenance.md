# PetHub Backend Maintenance Notes

## Runtime Compatibility

The backend remains a CommonJS Express app started with `npm start` / `node server.js`, which keeps Railway deployment compatibility intact.

Environment variables are centralized in `config/env.js`. Railway should continue setting:

- `PORT`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY` (the service role / secret key). The backend's shared database client uses it when it is set (`config/env.js`), falling back to `SUPABASE_ANON_KEY` otherwise; a public key pasted into `SUPABASE_SERVICE_KEY` by mistake is ignored. Password reset uses it too (`config/supabaseAdmin.js`, never the anon key). At startup the log line `supabase.client_key` names the variable and the kind of key in use (never the key). It must be the service role key before row level security is switched on (`database/migrations/2026-10-20_rls_least_privilege.sql`). Server-side only: never put it in frontend code or Vercel.
- `SUPABASE_ANON_KEY` (fallback only; the browser never talks to Supabase directly)
- `BREVO_API_KEY` (Brevo transactional email API key; verification, password reset and appointment approved/cancelled emails are sent through Brevo)
- `SENDGRID_FROM_EMAIL` (sender address for Brevo emails; the name is kept from the earlier SendGrid setup and must be a sender verified in Brevo)
- `SENDGRID_FROM_NAME` (sender display name for Brevo emails; defaults to `PetHub`)
- `GEMINI_API_KEY`
- `GEMINI_MODEL`
- `AUTH_TOKEN_SECRET` (at least 32 random characters; signs login session tokens. Without it, login is refused. Changing it signs every user out.)

Optional frontend origin settings:

- `FRONTEND_URL` (frontend origin; allowed by CORS and used for the My Appointments link in appointment emails, which is left out when it is not set)
- `CORS_ORIGINS` as a comma-separated list

Online payments (PayMongo deposits) were removed from PetHub. `PAYMENTS_ENABLED`, `PAYMONGO_SECRET_KEY`, `PAYMONGO_WEBHOOK_SECRET` and `PAYMONGO_API_URL` are no longer read and can be deleted wherever they are still set. The old `/payments/*` endpoints answer with the API 404. The database keeps the `payments` table and the `appointments.deposit_required` / `appointments.payment_status` columns (historical data, see `database/migrations/2026-10-17_paymongo_deposits.sql`); the application no longer reads or writes them.

## Accounts and Passwords

New passwords (registration and password reset) are stored as salted scrypt hashes by `utils/passwordHash.js` (Node's built-in `crypto`, no dependency). Login also accepts the values stored before hashing was introduced (plaintext and `sha256$...`), and the first successful login with such a value replaces it with a scrypt hash (`usersRepository.upgradeLegacyPassword`; it only touches rows that are not scrypt hashes yet, so a password reset made meanwhile is never overwritten, and the old value is never sent to the database). Accounts whose owners never log in again keep their old value until they reset it. Do not roll the backend back to a version older than the hashing change: older code compares plaintext and would refuse every account created or reset since.

Registration requires every field: full legal name, email, password and its confirmation, date of birth, gender ("Prefer not to say" is a valid answer), contact number (Philippine mobile or landline, or another country's number starting with + and its country code) and a Philippine home address (house/unit and street, barangay, city/municipality, province, 4-digit postal code). The rules are in `validators/authValidator.js` with the limits in `constants/userProfile.js`; `frontend/js/shared/profile-fields.js` repeats them for the forms and `tests/profile-fields.test.js` keeps the two in step. The details need `database/migrations/2026-10-20_users_profile_fields.sql`: apply it BEFORE deploying this backend, otherwise every registration is refused (503, nothing saved). `users.phone_number` already existed and holds the contact number.

Accounts created before the details were required keep NULL in those columns and can still log in and book. Their dashboard shows a "Complete your details" banner; the owner fills them in with `PUT /auth/profile` (signed-in owner only; every detail required; email, password, role and verification status are refused). The dashboard reads them through `GET /auth/user-status?include=profile` (owner only); admin user lists do not include them.

Roles: `PUT /admin/dashboard/user-role` accepts only `user` and `admin`, and refuses (409) to change the role of the last remaining administrator, including an administrator changing their own role, so the Admin Dashboard can never be left without an administrator. Role changes run one at a time within one backend process.

## Request Limits

`middleware/rateLimit.js` limits login, registration, email verification, verification-code resends, password reset, the contact form, the chatbot (per client IP) and profile updates (per account); the numbers are in `constants/rateLimits.js`. `GET /admin/system-logs?limit=` returns 20 entries by default and never more than 200. Over the limit the API answers 429 with `Retry-After`. `server.js` trusts one proxy hop (Railway) so the client IP is the visitor's. The counts live in memory: they reset when the server restarts and are not shared between instances.

## Services and Scheduling

The clinic's services (Bath, Trim, Puppy Cut, Full Grooming, Nail Cutting, Face Trim, Flea and Tick Removal, Medicated Bath, Dog & Cat Full Check Up) are stored in the `pethub_service_catalog` table (created by `2026-10-23_reconcile_live_schema.sql`) and edited by administrators in the Admin Dashboard (`GET /admin/services`, `PUT /admin/services/:id`, optimistic `version` check). `constants/services.js` only holds the seed values and test fixtures; it is not read at runtime to authorize a booking. The public Services page and the booking page load the catalog from `GET /appointments/services`. Until the table exists, those endpoints answer 503 and nothing can be booked.

Durations are NOT confirmed yet: every service is seeded with no duration and online booking off, so it cannot be booked until an administrator saves a clinic-confirmed duration, at least one species and turns online booking on (the database refuses "on" without the other two). Puppy Cut is seeded with no species because its species rule awaits the clinic. Bookings and approvals go through the `create_appointment_if_available` / `update_appointment_status_if_available` database functions, which lock the date so separate backend instances cannot double-book. Earlier service names saved on existing appointments (e.g. "Checkup") cannot be booked any more but those appointments keep their saved duration and can still be approved, completed or cancelled; one saved without a duration can be approved but blocks no time. New pet profiles must be a Dog or a Cat.

Cancelling (owner, at least 2 hours before the Asia/Manila start, or administrator) keeps the appointment row and records the time in `appointments.cancelled_at`.

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

Migration files in `database/migrations/` are prepared for review and run by hand in the Supabase SQL Editor; nothing applies them automatically and the project has no migration ledger (`supabase_migrations.schema_migrations` does not exist). Each file says in its header whether it has been applied.

Verified read-only against the live project on 2026-10-23 (details and evidence: `docs/live-database-reconciliation-2026-10-23.md`): the deployed Railway backend is ahead of the database. Run, in this order and each only after approval:

1. `2026-10-23_reconcile_live_schema.sql`: one transaction that adds the user profile columns, the one-open-reset-code index, the breed catalog and owner weight tables, `medical_records.appointment_id`, the service catalog and the three appointment functions. It stops without changing anything if the database is not in the verified state. It replaces running the 2026-10-20 profile, 2026-10-22 and 2026-10-23 service-catalog files separately.
2. `2026-10-20_rls_least_privilege.sql`: row level security on the 14 older tables (the backend already uses the service role key).

`2026-10-17_password_resets_attempts_and_rls.sql` and `2026-10-17_paymongo_deposits.sql` are partially applied and must not be run again.

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
