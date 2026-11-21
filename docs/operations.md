# Operations

## Health

`grpc.health.v1.Health/Check` on the gRPC port (`50051`) answers `SERVING` until shutdown starts and `NOT_SERVING` during the drain; `Watch` is not implemented. It checks nothing else because the service has no dependencies. The image `HEALTHCHECK` is a `grpc-js` client against the local port.

```bash
grpcurl -plaintext localhost:50051 grpc.health.v1.Health/Check
```

## Shutdown

On SIGTERM or SIGINT (`src/lifecycle.ts`): health goes `NOT_SERVING`, the server stops accepting calls and waits for in-flight RPCs for at most `SHUTDOWN_DRAIN_TIMEOUT_MS` (default 5000; a `Charge` in progress is answered, and the 3 s processing-error test card fits), then the rest is cancelled (`forceShutdown`), telemetry is flushed and the process exits 0. The routine is unit tested with fakes (`__tests__/lifecycle.test.ts`) and the process test checks that SIGTERM exits 0 with telemetry unset. A measured `docker stop` was not run for this page.

## Scaling and replicas

Stateless: scale freely. A refund id is derived from the transaction id, so every replica returns the same id for the same transaction.

## Failure behaviour

| Failure | Behaviour |
|---|---|
| Invalid card, brand not accepted, bad amount | `INVALID_ARGUMENT` with `<reason>: <text>` |
| Decline test cards | `FAILED_PRECONDITION` (`card_declined`, `insufficient_funds`) |
| Processing-error test card | `UNAVAILABLE` (`processing_error`) after about 3 s |
| Callers with a deadline below 3 s on that card | see `DEADLINE_EXCEEDED` instead of `UNAVAILABLE` |
| Uncaught exception or rejection | logged as one JSON line, exit 1 |
| Collector unreachable | the service keeps serving; export errors are logged |

## Runbook

| Symptom | Check |
|---|---|
| Checkout says "card rejected" / "card declined" | the message carries payment's reason prefix; see the test cards in [API](api.md) |
| A charge takes 3 s and fails | the processing-error test card `4000000000000119`, by design |
| Refund succeeds for any id | by design: the transaction is not looked up and the amount is not compared with the charge |
| Same refund id returned twice | by design: UUID v5 of the transaction id, safe to retry |

There is no dashboard or alert rule for this service in the repository yet (the dashboards are an open task).
