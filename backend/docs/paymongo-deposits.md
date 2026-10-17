# PayMongo appointment deposits (test mode)

New appointments need a ₱100 deposit, paid through PayMongo's hosted checkout, before an admin can approve them.
Appointments booked before deposits were switched on are exempt. Paying never approves an appointment: an admin
still approves it, and only an approved appointment holds its time slot.

## How it works

| Step | Code |
|---|---|
| The booking form shows "₱100 deposit required" (from `deposit_policy` in `GET /appointments/userAppointments`). "Book" opens a summary (pet, service, date, time, deposit, "Not paid yet", "paying does not approve"); "Pay Deposit and Continue" books and opens the checkout. | `frontend/js/user/appointments.js` |
| Booking (`POST /appointments/create`) sets `deposit_required = true` while `PAYMENTS_ENABLED=true` | `services/appointmentsService.js` |
| `POST /payments/checkout {appointment_id}` opens (or resumes) a 30-minute PayMongo checkout for the owner's Pending appointment. The amount (10000 centavos) is a server constant. Payment methods = PetHub's list (`gcash`, `qrph`, `card`) limited to what `GET /v1/merchants/capabilities/payment_methods` reports (cached 10 minutes; the test account reported only `qrph` on 2026-10-17). | `services/paymentsService.js` `createCheckout` |
| `POST /payments/webhook` records the payment after checking the `Paymongo-Signature` HMAC over the raw body, test mode, amount, currency, session id and PetHub metadata | `handleWebhook` |
| `GET /payments/appointment/:id` shows the owner the deposit state and asks PayMongo directly while a checkout is open (covers a late or missing webhook). The checkout redirect never counts as payment. | `getAppointmentPaymentStatus` |
| Approving through either status endpoint requires a paid deposit (`checkDepositForApproval`). A paid appointment whose slot is taken returns 409 with `refund_required: true`. | `adminService.updateAppointmentStatus`, `appointmentsService.updateStatus` |
| Cancelling expires any open checkout. A paid, cancelled appointment shows "Refund required" until a refund event arrives. | `handleAppointmentCancelled` |
| Every 5 minutes a sweep expires checkouts older than 30 minutes, after PayMongo confirms them (sessions never expire on their own), and retries confirmation emails that could not be sent. | `runExpirySweep` (started by `server.js`) |
| Admin pages show Awaiting payment / Payment pending / Paid — awaiting approval / Refund required / Refunded, and the Approve button is locked until the deposit is paid (the backend refuses it either way). | `frontend/js/admin/appointments.js`, `frontend/js/admin/dashboard.js` |

## Emails (Brevo, `utils/email.js`)

| Email | Sent when | Duplicates |
|---|---|---|
| "PetHub — Appointment Deposit Payment Confirmed" | A payment row becomes Paid after verification (webhook or server-side PayMongo check). Says the appointment still awaits the clinic; if the appointment was already cancelled or already paid, says a refund is due instead (never that one was made). | `payments.receipt_email_sent_at` is claimed before sending, so retried webhooks, status checks and the sweep send it once. A failed send releases the claim; the sweep retries for 24 hours. The payment stays Paid either way. |
| "PetHub — Appointment Approved" | An admin approves an appointment that needed a deposit (and has a verified one). | Status changes are conditional updates, so each decision is stored and emailed once. |
| "PetHub — Appointment Request Declined" / "Appointment Cancelled" | An admin cancels a Pending / Approved appointment that needed a deposit. With a paid deposit it explains a refund is due under the clinic's policy and that the email does not mean the refund was made. | Same as above. A failed decision email is logged, not retried. |

Appointments booked before deposits were switched on (exempt) get no new emails, and nothing is emailed while
`PAYMENTS_ENABLED` is off. Emails run in the background and never change payment or appointment state.
The links in emails use `FRONTEND_URL` (left out if it is not set).

Payment state comes only from `public.payments` (`Pending`, `Paid`, `Expired`, `Failed`, `Refunded`). Status changes are
conditional updates, so duplicate or late webhooks can never move a payment backwards. A payment that PayMongo confirms
after the local window is still recorded (shown as "paid (late)"). `appointments.payment_status` is not used.

The PayMongo client uses the v1 checkout endpoints (create, retrieve and expire are documented together). PayMongo
recommends v2 for creating sessions but documents no retrieve/expire for v2 sessions; run the v2 sandbox check below
before changing `CHECKOUT_SESSION_CREATE_PATH` in `utils/paymongoClient.js`.

## Configuration (server only; never in frontend files or git)

| Variable | Value |
|---|---|
| `PAYMENTS_ENABLED` | `true` turns deposits on. Unset or anything else = off (default, behaves exactly as before). |
| `PAYMONGO_SECRET_KEY` | Test secret key `sk_test_...` (Dashboard → Developers → API Keys). Live `sk_live_` keys are refused. |
| `PAYMONGO_WEBHOOK_SECRET` | The `whsk_...` secret PayMongo shows once when you create the test webhook endpoint. |
| `SUPABASE_SERVICE_KEY` | Service-role key. Payment rows are only read and written with it (`config/supabaseAdmin.js`). |
| `FRONTEND_URL` | Origin that serves `/pages/user/appointments.html`; PayMongo returns the customer there, and emails link to it. Falls back to the request's allowed Origin for the return URL. |
| `BREVO_API_KEY`, `SENDGRID_FROM_EMAIL`, `SENDGRID_FROM_NAME` | Existing email settings (same as verification and password reset emails). |

## Order of operations

1. Read-only checks: PART 1 of `database/migrations/2026-10-17_paymongo_deposits.sql` (approval needed).
2. Schema: PART 2 of that file, in a dev Supabase project first (approval needed).
3. Deploy the backend with `PAYMENTS_ENABLED` unset: nothing changes for users.
4. Add the test keys, register the test webhook, then set `PAYMENTS_ENABLED=true`.
5. After a test checkout and webhook work: PART 3 (RLS on `payments`, separate approval).

Rollback: set `PAYMENTS_ENABLED=false` and restart. Deposits are no longer required for approval and checkout closes;
webhooks for payments already made are still recorded.

## Test webhook

PayMongo Dashboard (test mode) → Developers → Webhooks → add endpoint `https://<backend-host>/payments/webhook`, events:
`checkout_session.payment.paid`, `payment.refunded` and `payment.refund.updated` (the names in PayMongo's webhook event
list; the handler also accepts `refund.succeeded`, which only PayMongo's go-live checklist mentions).
Register it only after the migration (PART 2): before that, events are answered with 500 and PayMongo retries them.
Copy the secret into `PAYMONGO_WEBHOOK_SECRET`. A webhook cannot reach `localhost` without a tunnel; locally the
status endpoint still confirms payments with PayMongo directly. The refund event payloads are not published by
PayMongo: send a Dashboard test event and confirm the handler reads it before relying on automatic "Refunded".

## Testing

- `npm test` runs the automated suite (fake Supabase, fake PayMongo, fake Brevo; no network, no charges, no emails).
- `PAYMONGO_SANDBOX_TESTS=1 npm test` also reads the account's payment methods, then creates, reads and expires a real
  test-mode session with them (no payment; every session it creates is expired again). It reports whether PayMongo
  honours `Idempotency-Key` (not documented by PayMongo) instead of requiring it.
  `PAYMONGO_SANDBOX_TESTS=v2` additionally checks whether v1 retrieve/expire accept a v2-created session.
- Manual sandbox payment: card `4343434343434345` (success), `4120000000000007` (3DS, choose Authorize),
  `4111111111111111` (declined); GCash shows a PayMongo test page with Authorize / Fail.
- **QR Ph codes are real even in test mode. Never scan and pay one with a banking app.**
- The local `backend/.env` points at the production Supabase project: local tests with `PAYMENTS_ENABLED=true` write
  real rows there. Prefer a separate dev Supabase project.

## Refunds (version 1)

Refunds are done by an admin in the PayMongo Dashboard (Payments → select → Refund). PetHub never refunds on its own.
"Refund required" clears only when PayMongo sends a succeeded refund for the full ₱100.
