# API

Package `hipstershop`, service `PaymentService` ([`proto/payment.proto`](https://github.com/platform-boutique/app-payment-service/blob/main/proto/payment.proto)); health in [`proto/health.proto`](https://github.com/platform-boutique/app-payment-service/blob/main/proto/health.proto).

| Method | Request | Response |
|---|---|---|
| `Charge` | `ChargeRequest{ Money amount, CreditCardInfo credit_card }` | `ChargeResponse{ transaction_id }` (a random UUID v4) |
| `Refund` | `RefundRequest{ string transaction_id, Money amount }` | `RefundResponse{ refund_id }` |

`CreditCardInfo` = `{ credit_card_number, credit_card_cvv, credit_card_expiration_year, credit_card_expiration_month }`. `Refund` (with `RefundRequest`/`RefundResponse`) is an additive change; `Charge` and every existing field number are unchanged.

### Charge

Checks, in this order (the first failure wins):

1. A card must be present and the number must pass `simple-card-validator` (Luhn + known brand; spaces and dashes are allowed).
2. Brand must be **Visa or MasterCard**.
3. Expiry month/year must not be in the past (a card expiring this month passes).
4. The documented test cards below then produce their simulated outcome; every other valid card succeeds.

The CVV and `amount` are **not** validated.

### Test cards

Use any future expiry and any CVV.

| Card number | Brand | Outcome | gRPC status | Message prefix |
|---|---|---|---|---|
| `4111111111111111` | Visa | success | `OK` | — |
| `5555555555554444` | MasterCard | success | `OK` | — |
| `4000000000000002` | Visa | generic decline | `FAILED_PRECONDITION` | `card_declined: ` |
| `4000000000009995` | Visa | insufficient funds | `FAILED_PRECONDITION` | `insufficient_funds: ` |
| `4000000000000119` | Visa | processing error after a **~3 s delay**; retriable | `UNAVAILABLE` | `processing_error: ` |
| `378282246310005` / `371449635398431` | Amex | brand not accepted | `INVALID_ARGUMENT` | `card_not_accepted: ` |

### Error mapping

Every error message is `<reason>: <human text>`; the reason is stable and machine-readable, the text is for people and may change.

| Failure | gRPC status | Reason prefix | Example message |
|---|---|---|---|
| Missing card, Luhn/length failure, unknown brand, expiration month outside 1-12 | `INVALID_ARGUMENT` | `invalid_card` | `invalid_card: Credit card info is invalid` |
| Brand other than Visa/MasterCard | `INVALID_ARGUMENT` | `card_not_accepted` | `card_not_accepted: Sorry, we cannot process amex credit cards. Only VISA or MasterCard is accepted.` |
| Expired card | `INVALID_ARGUMENT` | `expired_card` | `expired_card: Your credit card (ending 1111) expired on 1/2025` |
| Declined | `FAILED_PRECONDITION` | `card_declined` | `card_declined: Your card (ending 0002) was declined by the issuer` |
| Insufficient funds | `FAILED_PRECONDITION` | `insufficient_funds` | `insufficient_funds: Your card (ending 9995) has insufficient funds` |
| Processor error (retry later) | `UNAVAILABLE` | `processing_error` | `processing_error: The payment processor could not complete the charge; please retry` |
| Charge with a missing or negative amount | `INVALID_ARGUMENT` | `invalid_request` | `invalid_request: amount is required and must not be negative` |
| Refund without `transaction_id`, negative refund amount | `INVALID_ARGUMENT` | `invalid_request` | `invalid_request: transaction_id is required` |
| Anything unexpected | `INTERNAL` | `internal_error` | `internal_error: unexpected payment failure` (the real exception text is never returned) |

`checkout-service` currently wraps every payment error as `INTERNAL "failed to charge card: ..."`, so the code is lost there but the reason prefix survives inside the message.

### Refund

Simulated: nothing is stored and the transaction is **not looked up** (the service keeps no state), so any non-empty `transaction_id` is accepted. Blank (or whitespace-only) → `INVALID_ARGUMENT`; a negative `amount` → `INVALID_ARGUMENT`; `amount` is otherwise not checked against the charge. `refund_id` is a UUID v5 of the trimmed transaction id, so **the same transaction id always returns the same refund id** (safe to retry), whatever the amount.

### Card data in logs and traces

No log line, error message or span attribute contains a full card number or the CVV; the most that is logged is the brand and the last four digits (`"card":{"brand":"visa","last4":"1111"}`). The request object is not logged. As defence in depth the pino loggers redact `credit_card`, `credit_card_number` and `credit_card_cvv` (top level and one/two levels deep) to `[REDACTED]`. The gRPC instrumentation records the status message as a span attribute (`grpc.error_message`), which is why error messages carry at most the last four digits; it records no request payload or metadata (no metadata capture is configured). `__tests__/handlers.test.ts` captures the logger and fails if a full number, its first six digits or the CVV appears in the logs of any charge path.
