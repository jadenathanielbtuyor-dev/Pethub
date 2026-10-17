# PayMongo appointment deposits (test mode)

New appointments need a ₱100 deposit, paid through PayMongo's hosted checkout, before an admin can approve them.
Appointments booked before deposits were switched on are exempt. Paying never approves an appointment: an admin
still approves it, and only an approved appointment holds its time slot.

## How it works

| Step | Code |
|---|---|
| The booking form shows "₱100 deposit required" (from `deposit_policy` in `GET /appointments/userAppointments`) and a live summary (pet, service, date and time, deposit, payment status). "Continue to Secure Payment" is enabled once the details are valid and online payment is available; it books and opens the checkout. Until the deposit is verified, the booking is shown as "Booking incomplete", with its payment status shown apart. | `frontend/js/user/appointments.js` |
| The user dashboard leaves unverified deposit bookings out of the upcoming appointments and shows them as "not complete", with a link to finish the payment. | `frontend/js/user/dashboard.js` |
| Booking (`POST /appointments/create`) sets `deposit_required = true` while `PAYMENTS_ENABLED=true`. While deposits are on but none can be paid (PayMongo or `SUPABASE_SERVICE_KEY` not configured, or the migration missing), it refuses with 503 instead of booking without the deposit. Sending the same Pending booking again returns it (`already_booked`); copies that arrive at the same moment (two tabs, a double click) run one at a time per customer, so only one appointment is created. | `services/appointmentsService.js` |
| `POST /payments/checkout {appointment_id}` opens (or resumes) a 30-minute PayMongo checkout for the owner's Pending appointment. The amount (10000 centavos) is a server constant. Payment methods = PetHub's list (`gcash`, `qrph`, `card`) limited to what `GET /v1/merchants/capabilities/payment_methods` reports (cached 10 minutes; the test account reported only `qrph` on 2026-10-17). | `services/paymentsService.js` `createCheckout` |
| `POST /payments/webhook` records the payment after checking the `Paymongo-Signature` HMAC over the raw body, test mode, amount, currency, session id and PetHub metadata | `handleWebhook` |
| `GET /payments/appointment/:id` shows the owner the deposit state and asks PayMongo directly while a checkout is open (covers a late or missing webhook). It answers whatever `PAYMENTS_ENABLED` says, so a deposit-required appointment can always be checked. The checkout redirect never counts as payment. | `getAppointmentPaymentStatus` |
| Approving through either status endpoint requires a paid deposit (`checkDepositForApproval`). A paid appointment whose slot is taken returns 409 with `refund_required: true`. The schedule check and the status update of approvals on the same date run one at a time (`utils/keyedLock.js`), so two admins approving overlapping appointments at once get one approval and one 409. | `adminService.updateAppointmentStatus`, `appointmentsService.updateStatus` |
| Cancelling expires any open checkout. A paid, cancelled appointment shows "Refund required" until a refund event arrives. | `handleAppointmentStatusChanged` |
| Every 5 minutes a sweep expires checkouts older than 30 minutes, after PayMongo confirms them (sessions never expire on their own), and retries confirmation emails that could not be sent. | `runExpirySweep` (started by `server.js`) |
| Admin pages show Awaiting payment / Payment pending / Paid — awaiting approval / Refund required / Refunded, and the Approve button is locked until the deposit is paid (the backend refuses it either way). | `frontend/js/admin/appointments.js`, `frontend/js/admin/dashboard.js` |

## Emails (Brevo, `utils/email.js`)

| Email | Sent when | Duplicates |
|---|---|---|
| "PetHub — Appointment Deposit Payment Confirmed" | A payment row becomes Paid after verification (webhook or server-side PayMongo check). Says the appointment still awaits the clinic; if the appointment was already cancelled or already paid, says a refund is due instead (never that one was made). | `payments.receipt_email_sent_at` is claimed before sending, so retried webhooks, status checks and the sweep send it once. A failed send releases the claim; the sweep retries for 24 hours. The payment stays Paid either way. |
| "PetHub — Appointment Approved" | An admin approves an appointment that needed a deposit (and has a verified one). | Status changes are conditional updates, so each decision is stored and emailed once. |
| "PetHub — Appointment Request Declined" / "Appointment Cancelled" | An admin cancels a Pending / Approved appointment that needed a deposit. With a paid deposit it explains a refund is due under the clinic's policy and that the email does not mean the refund was made. | Same as above. A failed decision email is logged, not retried. |

Appointments that need no deposit (booked while deposits were off) get no new emails. Appointments that need one keep
their emails whatever `PAYMENTS_ENABLED` says. Emails run in the background and never change payment or appointment state.
The links in emails use `FRONTEND_URL` (left out if it is not set).

Payment state comes only from `public.payments` (`Pending`, `Paid`, `Expired`, `Failed`, `Refunded`). Status changes are
conditional updates, so duplicate or late webhooks can never move a payment backwards. A payment that PayMongo confirms
after the local window is still recorded (shown as "paid (late)"). `appointments.payment_status` mirrors it: set to
`Paid` once a deposit is verified and `Refunded` after a full refund (best effort: a database refusal is logged and never
undoes the payment). A `checkout_session.payment.paid` event that matches no payment row is acknowledged and changes
nothing; `payments.webhook_unmatched` says why: `not_created_by_pethub` (no PetHub metadata, e.g. a dashboard test event),
`payment_row_not_found` (PetHub metadata for a row this database lacks: compare `supabase_project`) or
`invalid_pethub_reference`. Other webhook log categories (ids and codes only, never payloads, keys or customer data):

| Log event | `reason` |
|---|---|
| `payments.webhook_rejected` (400) | `invalid_signature`, `malformed_event` |
| `payments.webhook_mismatch` (200, nothing recorded) | `inconsistent_reference` (session, reference number or metadata points at another PetHub payment) or `payment_details_mismatch` (amount, currency, mode, payment id); `problems` lists the fields |
| `payments.webhook_failed` (500, PayMongo retries) | `database_error` (a missing column is also reported as `payments.schema_missing` with `supabase_project`) or `processing_error` |
| `payments.webhook_refund_unmatched` | `payment_not_recorded` (503 for 6 hours so PayMongo retries, then acknowledged) |
| `payments.webhook_ignored` | `not_test_mode`, `unhandled_type` (e.g. `payment.paid`), `no_paid_payment`, `malformed_checkout_session`, `malformed_refund`, `refund_for_unpaid_row` |
| `payments.webhook_not_configured` (503) | `problems`: `paymongo_webhook_secret_missing` / `supabase_service_key_missing` |

A PayMongo Dashboard "send test event" only proves delivery: its sample checkout has no PetHub metadata, so it is
logged as `not_created_by_pethub` and changes nothing.

The PayMongo client uses the v1 checkout endpoints (create, retrieve and expire are documented together). PayMongo
recommends v2 for creating sessions but documents no retrieve/expire for v2 sessions; run the v2 sandbox check below
before changing `CHECKOUT_SESSION_CREATE_PATH` in `utils/paymongoClient.js`.

## Configuration (server only; never in frontend files or git)

| Variable | Value |
|---|---|
| `PAYMENTS_ENABLED` | `true` (any letter case): new bookings need the deposit (`POST /appointments/create` sets `deposit_required`, or refuses with 503 if it cannot be paid), the booking form shows the deposit (`deposit_policy`), and `POST /payments/checkout` opens checkouts. Unset or `false` = off (default): new bookings need no deposit and no checkout can be opened. Any other value (`1`, `yes`, `on`) is also off and logs `payments.flag_unrecognized` at startup. It never comes from the browser. Appointments already marked `deposit_required` keep their rules either way: approval needs a verified deposit, lists and `GET /payments/appointment/:id` show it, cancelling closes open checkouts, and webhooks, the expiry sweep and receipt emails keep running (the sweep runs whenever a test key and the service key are set). |
| `PAYMONGO_SECRET_KEY` | Test secret key `sk_test_...` (Dashboard → Developers → API Keys). Live `sk_live_` keys are refused. |
| `PAYMONGO_WEBHOOK_SECRET` | The `whsk_...` secret PayMongo shows once when you create the test webhook endpoint. |
| `SUPABASE_SERVICE_KEY` | Service-role key. Payment rows are only read and written with it (`config/supabaseAdmin.js`). |
| `FRONTEND_URL` | Origin that serves `/pages/user/appointments.html`; PayMongo returns the customer there, and emails link to it. Falls back to the request's allowed Origin for the return URL. |
| `BREVO_API_KEY`, `SENDGRID_FROM_EMAIL`, `SENDGRID_FROM_NAME` | Existing email settings (same as verification and password reset emails). |

## Order of operations

1. Read-only checks: PART 1 of `database/migrations/2026-10-17_paymongo_deposits.sql` (approval needed).
2. Schema: PART 2 of that file, in a dev Supabase project first (approval needed). Applied and verified on project
   `crudvruwaptsvesheijv` (2026-10-17: all four `payments` columns, `appointments.deposit_required` boolean NOT NULL
   default false; `payments.id` uuid, `amount` numeric NOT NULL, `payment_method` nullable).
3. Confirm Railway's `SUPABASE_URL` is that same project (the `supabase_project` field of `payments.webhook_unmatched`
   or `payments.schema_missing` logs shows the project id Railway uses; no key is logged).
4. Deploy the backend with `PAYMENTS_ENABLED` unset or `false`: nothing changes for new bookings.
5. Add the test keys and `FRONTEND_URL`, register the test webhook, then set `PAYMENTS_ENABLED=true`.
6. Run one real test-mode checkout end to end (see Testing), then decide whether to keep deposits on.
7. After a test checkout and webhook work: PART 3 (RLS on `payments`, separate approval).

The backend needs Node.js 20 or newer (`engines` in `package.json`; `@supabase/supabase-js` 2.99 requires it).

Rollback: set `PAYMENTS_ENABLED=false` and restart. New bookings no longer need a deposit and checkout closes.
Appointments booked with the deposit still cannot be approved until it is verified (cancel them, or switch deposits back
on so customers can pay); webhooks for payments already made are still recorded.

## Test webhook

PayMongo Dashboard (test mode) → Developers → Webhooks → add endpoint `https://<backend-host>/payments/webhook`, events:
`checkout_session.payment.paid`, `payment.refunded` and `payment.refund.updated` (the names in PayMongo's webhook event
list; the handler also accepts `refund.succeeded`, which only PayMongo's go-live checklist mentions). A `payment.paid`
subscription is harmless but not used: checkout payments are recorded from `checkout_session.payment.paid`, and
`payment.paid` deliveries are acknowledged as `unhandled_type`.
Register it only after the migration (PART 2): before that, events are answered with 500 and PayMongo retries them.
Copy the secret into `PAYMONGO_WEBHOOK_SECRET`. A webhook cannot reach `localhost` without a tunnel; locally the
status endpoint still confirms payments with PayMongo directly. The refund event payloads are not published by
PayMongo: send a Dashboard test event and confirm the handler reads it before relying on automatic "Refunded".

## Testing

- `npm test` runs the automated suite (fake Supabase, fake PayMongo, fake Brevo; no network, no charges, no emails).
- `PAYMONGO_SANDBOX_TESTS=1 npm test` also reads the account's payment methods, then creates, reads and expires a real
  test-mode session with them (no payment; every session it creates is expired again). It reports whether PayMongo
  honours `Idempotency-Key` (not documented by PayMongo) instead of requiring it. Result on 2026-10-17: account methods
  `[qrph]` only; create, retrieve (metadata intact) and expire passed; an `Idempotency-Key` replay created a second
  session, so PetHub never retries a create.
  `PAYMONGO_SANDBOX_TESTS=v2` additionally checks whether v1 retrieve/expire accept a v2-created session.
- Manual sandbox payment: card `4343434343434345` (success), `4120000000000007` (3DS, choose Authorize),
  `4111111111111111` (declined); GCash shows a PayMongo test page with Authorize / Fail.
- **QR Ph codes are real even in test mode. Never scan and pay one with a banking app.** While the account offers only
  QR Ph, a test payment needs a simulation that PayMongo provides for test mode, or a test card / GCash method enabled
  on the PayMongo account.
- The local `backend/.env` points at the production Supabase project: local tests with `PAYMENTS_ENABLED=true` write
  real rows there. Prefer a separate dev Supabase project.

## Requests at the same moment

| Case | Protection |
|---|---|
| Two checkouts for one appointment | Unique index `payments_one_pending_per_appointment` (database): the second gets 409 "already being prepared". |
| Duplicate webhook deliveries, parallel status checks | Conditional updates (`payment_status IN (...)`); the receipt email is claimed before sending. |
| The same deposit booking twice; two admins approving overlapping appointments | `utils/keyedLock.js`: one at a time per customer / per appointment date, **inside one backend process**. |

The last row assumes Railway runs one backend instance (the default). With more replicas the same rule needs the
database: for approvals, a SQL function that takes `pg_advisory_xact_lock` on the appointment date and does the overlap
check and the `UPDATE ... WHERE status = 'Pending'` in one transaction, called from both status endpoints; for bookings,
a partial unique index on `(user_id, pet_id, service_type, appointment_date, appointment_time) WHERE status = 'Pending'
AND deposit_required` (check for existing duplicates first). Neither is applied.

## Refunds (version 1)

Refunds are done by an admin in the PayMongo Dashboard (Payments → select → Refund). PetHub never refunds on its own.
"Refund required" clears only when PayMongo sends a succeeded refund for the full ₱100.
