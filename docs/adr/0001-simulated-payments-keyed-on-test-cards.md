# 1. Simulated payments, outcomes keyed on documented test cards, no card data in telemetry

Status: accepted (reconstructed from the code and the earlier README).

## Context

The shop needs a payment step that can succeed, decline and fail, so that checkout's saga (refund, failed order) can be exercised, but no real provider is involved and a demo must never handle real card data.

## Decision

`Charge` validates the card (Luhn and brand via `simple-card-validator`, Visa or MasterCard only, CVV range, expiry against an injected clock, amount) and then lets a short list of documented test card numbers decide the outcome: success, generic decline, insufficient funds, and a processing error after about 3 s. Every other valid card succeeds. Errors are `<reason>: <text>` with a stable reason. `Refund` is simulated too: nothing is stored, the transaction is not looked up, and the refund id is a UUID v5 of the transaction id, so a retry returns the same id. Card numbers and CVVs are never logged, put in an error message or recorded on a span (at most the brand and the last four digits); the loggers also redact the card fields.

## Consequences

- Deterministic, testable outcomes without randomness or amounts-based rules.
- `Refund` cannot check that the transaction exists or that the amount does not exceed it.
- Each `Charge` returns a new random transaction id; there is no idempotency key.
- Callers with a deadline below 3 s see `DEADLINE_EXCEEDED` on the processing-error card.
