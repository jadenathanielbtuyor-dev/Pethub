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

## Request Limits

`middleware/rateLimit.js` limits login, registration, email verification, verification-code resends, password reset, the contact form, the chatbot (per client IP) and profile updates (per account); the numbers are in `constants/rateLimits.js`. Over the limit the API answers 429 with `Retry-After`. `server.js` trusts one proxy hop (Railway) so the client IP is the visitor's. The counts live in memory: they reset when the server restarts and are not shared between instances.

## Services and Scheduling

The clinic's services (Bath, Trim, Puppy Cut, Full Grooming, Nail Cutting, Face Trim, Flea and Tick Removal, Medicated Bath, Dog & Cat Full Check Up) are defined once in `constants/services.js`, with the species each may be booked for (dogs and cats). The booking page loads them from `GET /appointments/services`; bookings are checked against them, including the pet's species.

Durations are NOT confirmed yet: every service has `durationMinutes: null`, so online booking answers 409 "cannot be booked online yet" until the clinic confirms each length (or one standard length in `STANDARD_DURATION_MINUTES`). Enter only confirmed minutes. The rule "Puppy Cut is for dogs only" is pending the clinic's confirmation and is not applied (`SPECIES_PENDING_CONFIRMATION`). Earlier service names saved on existing appointments (e.g. "Checkup") cannot be booked any more but those appointments keep their saved duration and can still be approved, completed or cancelled; one saved without a duration can be approved but blocks no time. New pet profiles must be a Dog or a Cat.

## Database Migrations

Migration files in `database/migrations/` are prepared for review and run by hand in the Supabase SQL Editor; nothing applies them automatically. Each file says in its header whether it has been applied. Pending as of 2026-10-20: `2026-10-20_users_profile_fields.sql` (before deploying the backend) and `2026-10-20_rls_least_privilege.sql` (after the backend runs with the service role key; it closes every table to the public key).

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
