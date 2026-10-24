# Migration ledger (live Supabase project `crudvruwaptsvesheijv`)

The live database has no `supabase_migrations.schema_migrations` table: the files below were run as SQL scripts
(SQL Editor or the Supabase MCP `execute_sql` tool), which keeps no history. This file is that history. A file's own
header describes its state when it was prepared; where the two differ, this ledger is the current record. Applied files
are kept byte-for-byte as executed (the SHA-256 values below), so their headers are not edited afterwards.
Never run an applied or superseded file again: each one's preflight stops it, but do not rely on that.

## Applied

| File | Applied (UTC) | How | Evidence |
|---|---|---|---|
| `2026-10-20_rls_least_privilege.sql` (PART 2 only) | 2026-10-23 17:55:06 | Supabase MCP `execute_sql`, one transaction | Postgres log statement; RLS on for all 14 original tables, 0 policies (verified 2026-10-24) |
| `2026-10-23_reconcile_live_schema.sql` (whole file) | 2026-10-23 23:51:03 | Supabase MCP `execute_sql`, one transaction | SHA-256 of the executed statement in the Postgres log = file SHA-256 `7ef68266625a553a84b2cb227003a57bd57e1b32353484b75276310b7534725c`; PART 0 and PART Z passed; objects, seeds and function bodies verified 2026-10-24 |
| `2026-10-24_revoke_api_role_table_grants.sql` | 2026-10-24 00:59:19 | Supabase MCP `execute_sql`, one transaction | Executed statement SHA-256 = file `bbd075f78fcc827c20d37b2c3ae14dc8417413a8160f1b2d424980a834a98db1`; anon/authenticated table grant entries 224 -> 0; service_role full access on all 17 tables; the public key now gets 401 / 42501 on every table |
| `2026-10-24_query_indexes.sql` | 2026-10-24 00:59:57 | Supabase MCP `execute_sql`, one transaction | Executed statement SHA-256 = file `572b1cb7dea3809a85419697dc9c173d46c2894386094b38963094bf9facfbb4`; public indexes 29 -> 37, all 8 valid and ready |
| `2026-10-24_core_value_checks.sql` | 2026-10-24 01:00:10 | Supabase MCP `execute_sql`, one transaction | Executed statement SHA-256 = file `a02aac3899eeb5fc83b853004c34cd392994921f703c3858d19153b3ccc5dbab`; public constraints 68 -> 71, all three validated |
| `2026-10-24_contact_cancellation_email_log.sql` | 2026-10-24 05:35:15 | Supabase MCP `execute_sql`, one transaction | Executed statement SHA-256 = file `ef12858793fe7a7389d54fc158a62cb80ca54e8489ba692c853ce6560a054cf8`; constraints 71 -> 82 (7 checks, 4 foreign keys), indexes 37 -> 41, status history trigger enabled, the 3 appointment functions and the trigger function executable only by postgres/service_role; every pre-existing row of every table hashed identically before and after |
| `2026-10-24_user_sessions.sql` | 2026-10-24 10:47:05 | Supabase MCP `execute_sql`, one transaction | Executed statement SHA-256 = file `f5e6924feb5301ac273eecc141a0006d6e2af346b77d43629adcd104374245ef`; public tables 17 -> 18, indexes 41 -> 43, constraints 82 -> 87; RLS on, 0 policies, privileges only for postgres/service_role; users/pets/appointments counts unchanged. Preceded by a genuine live dry run (file without BEGIN/COMMIT plus behaviour checks: API roles have no privilege, insert + revoke work, 4 of 4 bad rows refused, ended with a deliberate error; table confirmed absent afterwards) |
| `2026-10-24_multi_pet_booking_and_care_recommendations.sql` | 2026-10-24 15:25:37 | Supabase MCP `execute_sql`, one transaction (authorized by the owner) | Executed statement SHA-256 = file `37113ba5593c4fbb9b97140fdefa11333d3fcb5418d69ec6e27f3df9b41c45bc`; public tables 18 -> 21, indexes 43 -> 54, constraints 87 -> 118; RLS on with 0 policies and no anon/authenticated privilege on the 3 new tables; the 3 new functions executable only by postgres/service_role; column-list hashes of every pre-existing row of users, pets, appointments, services and activity_logs identical before and after. Preceded by a genuine live dry run (file without BEGIN/COMMIT plus 9 behaviour checks: group booking, overlap refusal, whole-booking cancel, reschedule, stale/conflict outcomes, rule and recommendation checks; ended with a deliberate error, database confirmed unchanged) |

`2026-10-24_contact_cancellation_email_log.sql` was first run on the live database without its BEGIN/COMMIT, followed by
behaviour checks and a deliberate error (genuine dry run, rolled back): owner cancellation sets cancelled_by and writes
history, another account's cancellation and a repeat cancellation return false, a start 1 h 59 min away is refused,
the admin path records history by the admin, the new checks and the unique email-log index refuse bad rows, and the
anon role cannot execute the cancellation function. The database was confirmed unchanged afterwards.

Before applying, all four earlier 2026-10-24 files ran together on the live database in one transaction that ended with a
deliberate error (genuine dry run: every preflight and post-check passed, then everything rolled back; grants,
indexes, constraints and default privileges were confirmed unchanged afterwards). After applying, every pre-existing
row in every table hashed identically to the pre-change snapshot.

## Not applied

| File | State |
|---|---|
| `2026-10-24_remove_legacy_plaintext_password.sql` | WITHDRAWN on 2026-10-25: DO NOT RUN. Never applied (blocked by the Claude Code permission classifier on 2026-10-24). Since 2026-10-25 the project owner decided that new passwords are stored as plain text and plain-text values log in (`docs/backend-maintenance.md`, Accounts and Passwords), so this file would lock those accounts out |
| `2026-10-24_optional_default_privileges.sql` | BLOCKED on 2026-10-24 by the Claude Code permission classifier before it reached the database (the statement is absent from the Postgres log; postgres's default privileges in `public` still grant anon/authenticated on future objects). It affects only objects created in the future. Run it in the SQL Editor, or allow the action, when wanted; its post-check verifies the result |

## Superseded or partially applied before 2026-10-23 (do not run)

| File | State |
|---|---|
| `2026-10-17_password_resets_attempts_and_rls.sql` | D1 applied earlier; D1b is in the reconcile file; D2 (RLS) is in the RLS file |
| `2026-10-17_paymongo_deposits.sql` | Columns applied earlier; online payments were removed from PetHub; indexes not needed |
| `2026-10-20_users_profile_fields.sql` | PART 2 applied through the reconcile file (PART A) |
| `2026-10-22_breed_catalog_and_owner_weight_reports.sql` | Applied through the reconcile file (PART C) |
| `2026-10-22_medical_record_appointment_link.sql` | Applied through the reconcile file (PART D) |
| `2026-10-22_owner_appointment_cancellation_rpc.sql` | Superseded by the reconcile file (PART E) |
| `2026-10-23_service_catalog_and_atomic_booking.sql` | Superseded by the reconcile file (PART F) |
