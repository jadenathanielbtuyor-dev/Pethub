# PetHub Backend Maintenance Notes

## Runtime Compatibility

The backend remains a CommonJS Express app started with `npm start` / `node server.js`, which keeps Railway deployment compatibility intact.

Environment variables are centralized in `config/env.js`. Railway should continue setting:

- `PORT`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY` or `SUPABASE_SERVICE_KEY`
- `SENDGRID_API_KEY`
- `SENDGRID_FROM_EMAIL`
- `SENDGRID_FROM_NAME`
- `GEMINI_API_KEY`
- `GEMINI_MODEL`
- `AUTH_TOKEN_SECRET` (at least 32 random characters; signs login session tokens. Without it, login is refused. Changing it signs every user out.)

Optional frontend origin settings:

- `FRONTEND_URL`
- `CORS_ORIGINS` as a comma-separated list

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

Forgot password, notifications, payments, and reminders should follow the same shape:

- add constants for statuses and timing first;
- add validators for request payloads;
- add repositories for new Supabase tables;
- add services for workflow rules;
- keep controllers thin;
- place reusable email or notification copy under `templates/`.

Do not put provider-specific payment or notification code directly in controllers.
