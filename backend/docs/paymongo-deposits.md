# PayMongo appointment deposits (test mode)

New appointments need a ₱100 deposit, paid through PayMongo's hosted checkout, before an admin can approve them.
Appointments booked before deposits were switched on are exempt. Paying never approves an appointment: an admin
still approves it, and only an approved appointment holds its time slot.

## How it works

| Step | Code |
|---|---|
| Booking (`POST /appointments/create`) sets `deposit_required = true` while `PAYMENTS_ENABLED=true` | `services/appointmentsService.js` |
| `POST /payments/checkout {appointment_id}` opens (or resumes) a 30-minute PayMongo checkout for the owner's Pending appointment. The amount (10000 centavos) is a server constant. | `services/paymentsService.js` `createCheckout` |
| `POST /payments/webhook` records the payment after checking the `Paymongo-Signature` HMAC over the raw body, test mode, amount, currency, session id and PetHub metadata | `handleWebhook` |
| `GET /payments/appointment/:id` shows the owner the deposit state and asks PayMongo directly while a checkout is open (covers a late or missing webhook). The checkout redirect never counts as payment. | `getAppointmentPaymentStatus` |
| Approving through either status endpoint requires a paid deposit (`checkDepositForApproval`). A paid appointment whose slot is taken returns 409 with `refund_required: true`. | `adminService.updateAppointmentStatus`, `appointmentsService.updateStatus` |
| Cancelling expires any open checkout. A paid, cancelled appointment shows "Refund required" until a refund event arrives. | `handleAppointmentCancelled` |
| Every 5 minutes a sweep expires checkouts older than 30 minutes, after PayMongo confirms them (sessions never expire on their own). | `runExpirySweep` (started by `server.js`) |

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
| `FRONTEND_URL` | Origin that serves `/pages/user/appointments.html`; PayMongo returns the customer there. Falls back to the request's allowed Origin. |

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
`checkout_session.payment.paid` and the refund event the Dashboard offers (`refund.succeeded`, or
`payment.refunded` / `payment.refund.updated`; PayMongo's pages list both, and the handler reads both).
Copy the secret into `PAYMONGO_WEBHOOK_SECRET`. A webhook cannot reach `localhost` without a tunnel; locally the
status endpoint still confirms payments with PayMongo directly.

## Testing

- `npm test` runs the automated suite (fake Supabase, fake PayMongo; no network, no charges).
- `PAYMONGO_SANDBOX_TESTS=1 npm test` also creates, reads and expires a real test-mode session (no payment);
  `PAYMONGO_SANDBOX_TESTS=v2` additionally checks whether v1 retrieve/expire accept a v2-created session.
- Manual sandbox payment: card `4343434343434345` (success), `4120000000000007` (3DS, choose Authorize),
  `4111111111111111` (declined); GCash shows a PayMongo test page with Authorize / Fail.
- **QR Ph codes are real even in test mode. Never scan and pay one with a banking app.**
- The local `backend/.env` points at the production Supabase project: local tests with `PAYMENTS_ENABLED=true` write
  real rows there. Prefer a separate dev Supabase project.

## Refunds (version 1)

Refunds are done by an admin in the PayMongo Dashboard (Payments → select → Refund). PetHub never refunds on its own.
"Refund required" clears only when PayMongo sends a succeeded refund for the full ₱100.
