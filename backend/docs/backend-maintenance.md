# PetHub Backend Maintenance Notes

## Runtime Compatibility

The backend remains a CommonJS Express app started with `npm start` / `node server.js`, which keeps Railway deployment compatibility intact.

Environment variables are centralized in `config/env.js`. Railway should continue setting:

- `PORT`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY` or `SUPABASE_SERVICE_KEY`
- `SUPABASE_SERVICE_KEY` (also required by password reset, which reads it only in `config/supabaseAdmin.js` and never falls back to the anon key; without it, password reset is unavailable but the rest of the backend still runs. Server-side only: never put it in frontend code or Vercel.)
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

New passwords (registration and password reset) are stored as salted scrypt hashes by `utils/passwordHash.js` (Node's built-in `crypto`, no dependency). Login also accepts the values stored before hashing was introduced (plaintext and `sha256$...`), so existing accounts keep working; their stored value only changes when the owner resets the password. Do not roll the backend back to a version older than this change: older code compares plaintext and would refuse every account created or reset since.

Registration also accepts optional profile details (date of birth, gender, contact number, address), validated in `validators/authValidator.js` with the limits in `constants/userProfile.js`. They need `database/migrations/2026-10-20_users_profile_fields.sql` (apply it before deploying the backend). Until it is applied, registrations without those details still work and registrations with them are refused with a clear message (503). `users.phone_number` already existed and holds the contact number. The user dashboard reads the details through `GET /auth/user-status?include=profile` (owner only); admin user lists do not include them.

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
