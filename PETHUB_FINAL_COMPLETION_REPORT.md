# PetHub Final Completion Report

**A Web Portal for Pet Status Tracking and Service Scheduling.** Final stabilization phase, 2026-10-24 (Asia/Manila).

- Starting point: commit `068d7e7`, already on `main` and already deployed.
- Final code: commit `f7f8840`, pushed and deployed. A documentation-only commit follows it.
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

**What still prevents a fully live booking demonstration:** none of the 9 services has a clinic-confirmed duration,
and Puppy Cut also has no species set. Online booking therefore stays closed until the clinic enters real values in
System Management. The clinic's contact details are also unpublished. Neither problem is a code defect, and no values
were invented.

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
                                 ├──> Supabase PostgreSQL (RLS on all 18 tables, no API-role grants;
                                 │      booking/cancel/status as atomic SQL functions; status-history trigger)
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

**Structure.** There are 18 public tables. RLS is on for all 18, with 0 policies and 0 grants to
`anon`/`authenticated`. Only the backend's service role reaches the data. The 4 functions
(`create_appointment_if_available`, `cancel_appointment_for_owner`, `update_appointment_status_if_available` and the
status-history trigger function) can be executed only by `postgres` and `service_role`.

**Counts.** 87 constraints and 43 indexes. The new `user_sessions` table accounts for +5 constraints and +2 indexes.

**Supabase advisors** report INFO-level findings only:

- RLS enabled with no policies: intentional, because only the backend reads the database.
- 15 unindexed foreign keys and 7 unused indexes: on tables with single-digit row counts. Left alone.

**Production data:** 5 users, 3 pets, 2 appointments (both Completed), 0 medical records, 90 breeds and 9 services.
No production record was deleted or altered. The only additions are listed in section 24.

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

**Live (read-only):**

- 9 services, all off. None has a clinic-confirmed duration; Puppy Cut also has no species.
- The public catalog shows none of them as bookable.
- The server refused to switch on an unconfigured service (422), and the service's version stayed 1.

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

**Live:** booking was not possible because no service is bookable. Live read-only checks confirmed the owner can't
cancel a Completed appointment (409), can't cancel an unknown appointment (404), and that an invalid id is handled
safely (404). The appointment history is intact: 2 Completed rows.

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
- The overview endpoint takes about 2–2.7 s on Railway; signed-in requests take about 0.7 s, where network latency
  dominates.
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

**Documentation commit:** this report, `backend/database/migrations/APPLIED.md` and
`backend/docs/backend-maintenance.md`.

## 20. Database objects modified

**Created:** `public.user_sessions`, with:

- primary key and foreign key to `users` (`ON DELETE CASCADE`);
- 3 check constraints: `expires_at > created_at`; `revoked_reason ∈ {logout, password_reset}`; revoked time and
  reason set together;
- partial index `user_sessions_user_id_open_idx`;
- RLS on with no policies, privileges for `postgres` and `service_role` only.

No other object was changed.

## 21. Migrations applied

| File | State |
| --- | --- |
| `2026-10-24_user_sessions.sql` | **Applied** 10:47:05 UTC (dry run first; hash verified; recorded in `APPLIED.md`) |
| `2026-10-24_remove_legacy_plaintext_password.sql` | **Not applied**: blocked by the permission classifier (section 8) |
| Earlier files (including `2026-10-24_contact_cancellation_email_log.sql`) | Verified in place; **not re-run** |
| `2026-10-24_optional_default_privileges.sql` | Still not applied (optional; affects future objects only) |

## 22. Test totals

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

## 24. Live production verification

**Live writes made, all with the designated test accounts:**

- 1 contact message, `[PetHub test] Final verification` (id `8da3fb14-…`), and its reply. Both are labelled as a test.
- 1 `email_logs` row (Sent, delivered).
- 10 `user_sessions` rows: 8 ended by logout. 2 remain open from the phone-width browser pass and expire at 18:54
  UTC.
- About 21 `activity_logs` rows from sign-ins, sign-outs, mark-read and reply.

**Live read-only:** sections 12–18 and 22.

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
| Documentation commit | Pushed after this report. Docs only; no code changes |

## 26. Remaining configuration requirements

These are owner or clinic actions. The system is in a safe state without them.

1. **Service durations and species.** Enter real values in System Management → Services & booking. All 9 services
   need a duration; Puppy Cut also needs species. Until then online booking is closed.
2. **Clinic contact details.** Enter phone, email, address and hours in System Management → Contact messages, so they
   appear on the Contact page and in emails.
3. **Legacy password value.** Run `2026-10-24_remove_legacy_plaintext_password.sql`, or have that account owner use
   "Forgot password?".
4. **Optional:** on Railway, set `BREVO_SENDER_EMAIL` / `BREVO_SENDER_NAME`, then remove the `SENDGRID_*` variables.
   Not required today.
5. **Optional:** delete the stale `pethub-beige.vercel.app` deployment. It runs old frontend code and is still on the
   backend's explicit CORS list.
6. **Optional:** run `2026-10-24_optional_default_privileges.sql`, so future tables are never granted to API roles by
   default.

## 27. Known limitations

**Not tested live:**

- Booking, approval, cancellation and their emails: no bookable service exists yet. These were verified locally and
  in the isolated full stack.

**Not built (future recommendations, out of scope for this phase):**

- Opening-hours enforcement and a booking horizon.
- A cap on pending requests per account.
- Appointment reminders.
- A "log out of all devices" control.
- Logging of verification and reset emails in `email_logs`.
- An attempt counter for the email verification code.
- Registering pets under 1 year old.
- Pagination of admin lists.

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
- [ ] Optional, only if the demo should include live booking: enter the clinic's real durations, and Puppy Cut's
  species, in System Management. Otherwise show the "temporarily unavailable" state and the setup dialog without
  saving.
- [ ] Optional: enter the clinic's real contact details.

During the demonstration:

- [ ] **Public site:** Home → Services (honest availability) → Contact (login prompt).
- [ ] **Owner:** log in → Overview → My Pets → Appointments (history; cancel dialog if a future appointment exists) →
  Pet Health and AI assistant → Contact (send a message, see the reply).
- [ ] **Admin:** log in → Overview (live counts, charts) → Appointment Management (approve/complete rules) → System
  Management → Contact messages (open, reply, delivery status) → Services & booking (setup dialog) → Activity logs.
- [ ] **Security:** log out and show that the old session is refused. Point to the CSP header in the browser's
  developer tools, and to RLS with no API grants in Supabase.
- [ ] **Explain the distinction:** contact, sessions and headers are *implemented, deployed and live-tested*. Booking
  and cancellation are *implemented, deployed and tested in isolation*. They become live-usable once the clinic
  configures its services.

| Acceptance area | Status |
| --- | --- |
| Core application (pages, login, dashboards, correct backend and database) | Pass (live) |
| Services (configure, switch, refuse unavailable, history intact) | Pass (isolated full stack + live refusals). Live activation waits for clinic data |
| Appointments (book, approve, transitions, 2 h cutoff, history, email) | Pass (local + isolated full stack). Live booking waits for clinic data |
| Contact (login required, verified sender, read, reply, email) | Pass (live, delivered) |
| Security (no new plaintext, sessions, roles, ownership, keys, headers) | Pass (live). Legacy value: storage removal pending (section 8) |
| Database (migration state, no duplicates, no deletions, constraints, RLS) | Pass (live) |
| Deployment (backend, frontend, connectivity) | Pass (live) |
