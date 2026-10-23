# PetHub live database reconciliation (2026-10-23)

**Status: prepared, NOT applied.** The live database was inspected read-only. No SQL that changes the database was run.

## How the live state was established

- Target: the PetHub Supabase project that the Railway backend and the local `backend/.env` both use. It holds the clinic's real accounts, so it is production.
- Access: the Supabase MCP server configured with `read_only=true`. Every query ran in a read-only transaction (`transaction_read_only = on` was checked). The session had no `apply_migration` tool.
- Only catalog metadata (`information_schema`, `pg_catalog`), aggregate counts, distinct status/service values and API log aggregates were read. No password, code, token, e-mail address or other row contents were read or printed.
- Supabase API logs (last 24 h) show which key and host made each request. No IP addresses were recorded.

## What the live database looks like

| Area | Live state (2026-10-23) |
| --- | --- |
| Migration ledger | none: `supabase_migrations.schema_migrations` does not exist; everything was run by hand |
| Tables | 14 in `public`: users (5 rows), pets (3), appointments (2), email_verifications (5), medical_records (**0**), activity_logs (55), contact_messages (0), password_resets (3), payments (1), notifications, appointment_status_history, email_logs, reminder_logs, system_settings (all 0). The last six are not used by the application. |
| RLS / grants | RLS **off** on all 14 tables, 0 policies; `anon` and `authenticated` hold every privilege (arwdDxtm, including TRUNCATE) on every table |
| Functions / triggers | none in `public` |
| Indexes | primary keys, `users_email_key` (unique, case-sensitive), `appointments_appointment_reference_key`, `system_settings_setting_key_key` only. The 18 foreign keys have no covering index (advisor INFO; the tables are tiny). |
| Foreign keys | users → pets / appointments / email_verifications / password_resets / notifications **ON DELETE CASCADE**; pets → medical_records **CASCADE**; pets → appointments SET NULL |
| Data shape | 1 admin + 4 owners, all verified and Active; **2 owner accounts still store a legacy non-hashed password value** (the admin uses scrypt); 3 pets (all Dog, ages 1–25); 2 appointments, both `Completed`, service `Checkup`, with `pet_id` and a duration, owner matches the pet's owner; 0 users with more than one open reset code; 0 e-mail duplicates by case |
| Backend key | 100% of PostgREST requests in the last 24 h used the **service_role** key, from Railway and from one local machine; there were no anon-key requests |
| Deployed code | Since 2026-10-23 03:12Z, Railway requests `pethub_service_catalog` (added in commit bfc5adc), so it runs the current code |

## Differences between the database, the migrations and the code

| Item | Live state | What the deployed code needs | Impact now | Correction | Data risk | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `users` profile columns (date_of_birth, gender, address_line, barangay, city_municipality, province, postal_code) | missing (log: `column users.date_of_birth does not exist`, 13×) | registration inserts them; dashboard reads/updates them | **every registration answers 503**; "Your details" cannot be read or saved | reconcile PART A (7 nullable columns + CHECKs) | none: nullable, no rewrite; existing 5 accounts keep NULL | Prepared but not applied |
| `medical_records.appointment_id` + FK + partial unique index | missing (log: `column medical_records.appointment_id does not exist`, 20×) | selected by every medical-record read and the insert | **Admin Appointment Management 500**, owner pet history 500, owner Health records 500, no official record can be created | reconcile PART D | none: table has 0 rows; future standalone records stay NULL | Prepared but not applied |
| `pet_breed_catalog`, `owner_pet_weight_reports` | missing (PostgREST 404) | breed suggestions, breed validation, owner-reported weights | **adding/editing a pet with a listed breed answers 503**; breed search and admin breed catalog 503; owner weight history unavailable | reconcile PART C (seed: 48 AKC dog + 40 CFA cat breeds, Aspin/Puspin unverified) | none (new tables) | Prepared but not applied |
| `pethub_service_catalog` + `create_appointment_if_available` + `update_appointment_status_if_available` | missing (PostgREST 404 / no functions) | public Services page, booking page, admin service settings, booking, **admin approval** | Services/booking/admin settings 503; **admins cannot approve appointments** (503) | reconcile PART F (9 services seeded with booking OFF and no duration) | none (new objects; no existing appointment changed) | Prepared but not applied |
| `cancel_appointment_for_owner` | missing | owner cancellation | owner cancellation 503 | reconcile PART E (also stamps the existing `appointments.cancelled_at`) | changes only Pending/Approved → Cancelled, ≥ 2 h before the Asia/Manila start; never deletes | Prepared but not applied |
| `password_resets_one_open_code_per_user` | missing (the `attempts` column from the same 2026-10-17 file exists) | parallel reset requests rely on its 23505 | two parallel requests could e-mail two codes | reconcile PART B | none (0 users with > 1 open code) | Prepared but not applied |
| RLS / API-role grants | RLS off; anon/authenticated full access | the browser never uses Supabase; the backend uses service_role | **anyone holding the public key can read and change every row, including password values, verification codes and reset tokens** | `2026-10-20_rls_least_privilege.sql` (RLS on, no policies) | lockout risk only if the backend lost its service_role key; logs show it uses it | Blocked pending approval |
| `payments` indexes (2026-10-17 PayMongo file) | columns present, indexes absent | nothing (payments removed) | none | none: superseded | n/a | Verified: not needed |

## Migration file status

| File | Status (verified 2026-10-23) | Action |
| --- | --- | --- |
| `2026-10-17_password_resets_attempts_and_rls.sql` | partially applied (D1 yes; D1b index no; D2 RLS no) | do not run; D1b is in the reconcile file, D2 in the RLS file |
| `2026-10-17_paymongo_deposits.sql` | partially applied (columns yes; indexes no); superseded | do not run |
| `2026-10-20_users_profile_fields.sql` | not applied | included in the reconcile file |
| `2026-10-20_rls_least_privilege.sql` | not applied | run **after** the reconcile file, separately approved |
| `2026-10-22_breed_catalog_and_owner_weight_reports.sql` | not applied | included in the reconcile file |
| `2026-10-22_medical_record_appointment_link.sql` | not applied | included in the reconcile file |
| `2026-10-22_owner_appointment_cancellation_rpc.sql` | not applied; superseded | included in the reconcile file (with `cancelled_at`) |
| `2026-10-23_service_catalog_and_atomic_booking.sql` | not applied; superseded | included in the reconcile file (with `cancelled_at`) |
| `2026-10-23_reconcile_live_schema.sql` | new; preflight checked live (read-only DO block: passed) | **step 1** |

## Runbook (for the person approved to change the database)

1. Before you start: in Supabase, open Database → Backups and note the latest backup time (or take one on a paid plan). Have the Railway logs open.
2. Open the SQL Editor of the PetHub project and paste **all** of `2026-10-23_reconcile_live_schema.sql`. Run it once.
   - If it says `PetHub reconciliation stopped` or `post-check failed`, nothing was changed. Keep the message and stop.
   - A `NOTICE` about existing medical records is informational.
3. Smoke test with accounts the clinic controls:
   - Register a new test account and verify it.
   - Add a pet with a listed breed and open its history and the Health page.
   - Admin: Appointment Management loads, the service settings load, the breed catalog loads.
   - Approve and cancel a **test** appointment only. Do not touch customers' appointments.
4. With separate approval, run PART 2 of `2026-10-20_rls_least_privilege.sql` (PART 1 checks first; run each check on its own). Repeat the smoke test, including forgot-password.
5. Optional, separately decided: the defence-in-depth `REVOKE` at the end of the RLS file.

**Recovery.** A failed run changes nothing, because the reconcile file is one transaction with in-transaction checks. After a successful run, prefer forward fixes. Do not drop the new objects once real data is in them; roll back the backend code instead, since the additive objects do not affect older code. The commented reverse script at the end of the file is only for a database where none of the objects have been used. For RLS, do not disable it as a rollback: fix `SUPABASE_SERVICE_KEY` on Railway instead.

## Isolated real-database verification (not the live project)

`2026-10-23_reconcile_live_schema.sql` and `2026-10-20_rls_least_privilege.sql` were run on PGlite 0.2.17, which is PostgreSQL 16.4 compiled to WebAssembly (the live database is 17.6). The copy was in memory and rebuilt from the live metadata above, including Supabase's default grants, with made-up rows. 14 of 14 checks passed:

- preflight stops (and changes nothing) on duplicate open reset codes and on a pre-existing function;
- applies in one transaction, and an earlier medical record stays unlinked;
- a second run stops at the preflight;
- profile CHECKs;
- one open reset code per user;
- owner cancellation:
  - more than 2 h before the start: allowed, the row is kept and `cancelled_at` is set;
  - less than 2 h, already started, another owner's, stale status, or a terminal status: refused;
  - exact 2-hour boundary: eligible;
- booking:
  - disabled service, wrong owner, wrong species, duration mismatch: refused;
  - a repeated request returns the existing booking;
  - overlaps refused, including across midnight;
  - back-to-back bookings allowed;
- approval: overlap with an Approved visit is refused; stale and not-found answers; a cancellation stamps `cancelled_at`; an invalid transition is refused;
- medical-record link:
  - one record per appointment;
  - standalone records allowed;
  - an appointment with a linked record cannot be deleted;
- new tables and functions are closed to anon/authenticated and open to service_role;
- before the RLS step, anon can read `users.password` (reproducing the live exposure); after it, anon/authenticated see 0 rows in every table while service_role works.

True concurrency (two simultaneous connections) is not testable on single-connection PGlite. It relies on PostgreSQL's row and advisory locks.

## Decisions the clinic or project owner still has to make

- **Service durations, species per service, and whether each is bookable online.** Booking stays closed until these are entered in the Admin Dashboard. Clinic hours, capacity and lead time are not modelled, and nothing was invented.
- **Legacy passwords.** 2 owner accounts still hold non-hashed values. Each is replaced automatically at that user's next successful login. Otherwise the clinic can ask them to reset.
- **Data retention.** Deleting a `users` row (for example from the Supabase dashboard) cascades to that owner's pets, appointments and **official medical records**. Decide whether clinical history must be kept (`ON DELETE RESTRICT`) before anyone deletes an account. There is no account-deletion feature in PetHub.
- **One official record per appointment.** The admin UI only adds a record from a completed appointment, and the database will allow one per appointment. If a visit can produce several records, the unique index must be revisited before such a workflow is built.
- **The six unused tables** (`notifications`, `payments`, `appointment_status_history`, `email_logs`, `reminder_logs`, `system_settings`). Keep them, which is the default since `payments` holds 1 historical row, or retire them later with a reviewed backup.

## Re-verified 2026-10-24: still not applied, ready to run

Claude could not apply either file. The Supabase MCP is read-only (`supabase_read_only_user`, `transaction_read_only = on`, no migration tool). No browser-automation tool is connected to a signed-in Supabase Dashboard. No Supabase CLI or `psql` is installed. Everything below was read-only.

| Check | Result |
| --- | --- |
| Target project | The backend's `SUPABASE_URL` host and the MCP's project ref are the same project: `crudvruwaptsvesheijv` |
| Reconcile PART 0 preflight, run live | **Passes**: no object exists yet, column types match, no user has two open reset codes |
| Backend key | All 282 PostgREST requests in the last 24 h used the `service_role` key (both `apikey` and `Authorization`); none used the public key. This satisfies the RLS file's step 0/1. |
| RLS PART 1a | RLS off on all 14 tables; none forced |
| RLS PART 1b | 0 policies. **PART 3b is not needed.** |
| RLS PART 1c (effective privileges, via `has_table_privilege`) | `anon` and `authenticated`: SELECT, INSERT, UPDATE, DELETE and TRUNCATE on all 14 tables. `information_schema.role_table_grants` lists nothing to a read-only role, so use `has_table_privilege` to see this. |
| RLS PART 1c.2 | `anon` can SELECT `users.password`, `email_verifications.verification_code` and `password_resets.reset_token` |
| RLS PART 1d / 1e | Only `service_role` bypasses RLS. 0 functions and 0 views in `public`. |

**Note on TRUNCATE.** RLS does not govern TRUNCATE. The public API (PostgREST) has no way to issue a TRUNCATE, and no callable function exists, so PART 2 closes every reachable path. The optional `REVOKE` at the end of the RLS file is what removes the privilege itself.

**Operator checklist (Supabase Dashboard → project `crudvruwaptsvesheijv` → SQL Editor):**

1. Note the latest backup under Database → Backups.
2. New query: paste the **whole** `2026-10-23_reconcile_live_schema.sql` and run it once.
   - Success shows no error.
   - `PetHub reconciliation stopped` or `post-check failed` means nothing changed. Copy the message and stop.
3. Tell Claude. Claude verifies the result read-only through the MCP: objects, seeds, grants, functions, and that existing rows are intact.
4. Smoke test with clinic-controlled accounts (step 3 of the runbook above).
5. New query: paste **only** PART 2 of `2026-10-20_rls_least_privilege.sql` (from `BEGIN;` to `COMMIT;`) and run it.
6. Tell Claude again. Claude verifies:
   - RLS is on for all 17 tables, with 0 policies;
   - a request made with the public key returns no rows (row counts only; no data is printed);
   - the backend still answers through the `service_role` key.
7. Repeat the smoke test, including forgot-password.
