# Known limitations

- Simulation only: no provider integration and no persistence. Each `Charge` yields a new transaction ID (no idempotency key); `Refund` cannot check that the transaction exists, or that the amount does not exceed it.
- Outcomes are keyed only on the documented test card numbers; there are no amount-based or random declines.
- The processing-error card blocks its call for ~3 s (a timer, not CPU); callers with a deadline below 3 s see `DEADLINE_EXCEEDED` instead of `UNAVAILABLE`.
- `checkout-service` does not call `Refund` yet and maps every payment error to `INTERNAL` (with the reason inside the message).
- `SIGTERM` does not terminate the process; the Docker `HEALTHCHECK` depends on `PORT` being set.
