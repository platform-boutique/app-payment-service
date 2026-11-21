# Known limitations

- Simulation only: no provider integration and no persistence. Each `Charge` yields a new transaction ID (no idempotency key); `Refund` cannot check that the transaction exists, or that the amount does not exceed it.
- Outcomes are keyed only on the documented test card numbers; there are no amount-based or random declines.
- The processing-error card blocks its call for ~3 s (a timer, not CPU); callers with a deadline below 3 s see `DEADLINE_EXCEEDED` instead of `UNAVAILABLE`.
- `checkout-service` calls `Refund` once, with the transaction id of the charge, when shipping fails after a successful `Charge` (no retry; if it fails the order says the refund is pending), and passes payment's gRPC codes through (see its README, error codes). Checked in its `origin/main` code on 2026-11-21; not run against this service for this table.
- On `SIGTERM` in-flight RPCs are drained for at most `SHUTDOWN_DRAIN_TIMEOUT_MS` (default 5 s); a call that outlasts it is cancelled. The `Check` health handler answers `NOT_SERVING` during the drain, but `Watch` is not implemented.
