# payment-service

A gRPC service that "processes" payments for the platform-demo e-commerce platform. It validates a credit card (number checksum, brand, expiry), simulates declines and processor errors for documented test cards, returns a random transaction ID, and simulates refunds. **No real payment provider is involved and nothing is persisted** — it is a simulation. It is stateless, has no downstream dependencies, and is called only by `checkout-service`.

Part of the [platform-demo](https://github.com/platform-boutique) platform — microservices, observability (LGTM stack), GitOps (Argo CD), policy enforcement (Kyverno), infrastructure provisioning (Terraform) and an internal developer portal (Backstage). See the master `README.md` in the platform-demo root for the whole-system view.

## At a glance

| | |
|---|---|
| **Language / runtime** | TypeScript on Node.js 22 (`@grpc/grpc-js`) |
| **Image** | `mladenovskistefan/payment-service` |
| **Protocol / port** | gRPC (HTTP/2, plaintext) on `50051` |
| **Metrics** | Pushed over OTLP/gRPC to Alloy → Mimir every 15 s (no scrape endpoint). Dashboard names: `rpc_server_duration_seconds_{bucket,count,sum}`, `rpc_server_requests_total`, `rpc_server_active_requests` |
| **Health** | `grpc.health.v1.Health/Check` on `50051` — static `SERVING` |
| **State** | None |
| **Depends on** | Nothing (optional: OTLP collector, Pyroscope) |
| **Called by** | `checkout-service` (`Charge`; `Refund` is not called yet) |
| **gRPC reflection** | Not enabled — pass `-proto` to `grpcurl` |

## API

Package `hipstershop`, service `PaymentService` ([`proto/payment.proto`](proto/payment.proto)); health in [`proto/health.proto`](proto/health.proto).

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

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `50051` | gRPC listen port. **Must be set when relying on the Docker `HEALTHCHECK`** (see below) |
| `NODE_ENV` | `production` (set in image) | |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset (telemetry off) | OTLP/**gRPC** endpoint for **traces, metrics and logs** (scheme required), e.g. `http://alloy.monitoring.svc.cluster.local:4317`. Legacy fallback: `COLLECTOR_SERVICE_ADDR` (`host:port`). Telemetry is on **only if** one of them is set and non-empty |
| `OTEL_SDK_DISABLED` | unset | `true` forces traces/metrics/logs export off even if an endpoint is set (standard OpenTelemetry switch) |
| `ENABLE_TRACING` | unset | Legacy switch: `0` forces traces/metrics/logs export off as well |
| `OTEL_METRIC_EXPORT_INTERVAL` | `15000` | Milliseconds between metric pushes |
| `OTEL_SERVICE_NAME` | `payment-service` | `service.name` — becomes the Prometheus `job` and the Loki `service_name`; keep the default, dashboards depend on it |
| `SERVICE_VERSION` | `1.0.0` | `service.version` resource attribute |
| `PYROSCOPE_ADDR` | unset (profiling off) | Profiles use the Pyroscope SDK push protocol (**not** OTLP). Point it at Alloy (`http://alloy.monitoring.svc.cluster.local:4040`), which forwards to Pyroscope, or directly at Pyroscope. Profiling is on **only if** it is set and non-empty |
| `ENABLE_PROFILING` | unset | `0` forces profiling off even if `PYROSCOPE_ADDR` is set |

Notes:

- There are **no secrets** and no external credentials: the service never talks to a real processor.
- Telemetry is **pushed**, not scraped: traces, metrics and logs share one OTLP/gRPC endpoint (Alloy); profiles go to Pyroscope (via Alloy). `service.instance.id` is the pod hostname, so replicas stay distinct in Mimir.
- The former Prometheus endpoint (`METRICS_PORT`) no longer exists. Logs keep going to stdout and are additionally exported over OTLP with trace ids.
- With none of the endpoints set the service starts with telemetry and profiling **off**, makes no outbound connections and logs no connection errors; the startup line says what is on (`"telemetry":"off: no OTEL_EXPORTER_OTLP_ENDPOINT / COLLECTOR_SERVICE_ADDR","profiling":"off: no PYROSCOPE_ADDR"`). Deployments that set the endpoints explicitly behave as before. With telemetry off, logs still go to stdout (without trace ids). If an endpoint is set but unreachable, the exporters log errors and the service keeps serving.

## Container image

Multi-stage [`Dockerfile`](Dockerfile):

| Stage | Base | What happens |
|---|---|---|
| builder | `node:22.22.2-alpine3.23` | `npm ci --ignore-scripts`, `npm run build` (tsc → `dist/`), `npm prune --omit=dev` |
| runtime | `node:22.22.2-alpine3.23` | copies `node_modules`, `dist/`, `proto/`; runs as non-root |

- **Entrypoint:** `node dist/server.js` (working dir `/app`).
- **User:** `appuser` — UID `100`, GID `101` (verified). Set `runAsUser: 100` for `runAsNonRoot`.
- **EXPOSE:** `50051` only.
- **Docker `HEALTHCHECK`:** `grpc-js` client to `localhost:$PORT`. It reads `process.env.PORT` with no default, so it **fails if `PORT` is unset**. Kubernetes ignores it, but set `PORT` explicitly.
- **Image size:** ~73 MB.

## Kubernetes deployment notes

**Workload:** stateless `Deployment`; scale freely.

**Ports to declare**

| Name | Port | Protocol | Expose via Service? |
|---|---|---|---|
| `grpc` | `50051` | TCP (HTTP/2) | Yes — `checkout-service` dials `payment-service:50051` |

**Service DNS name expected by callers:** `payment-service` (`checkout-service`: `PAYMENT_SERVICE_ADDR=payment-service:50051`). Note the same port number (`50051`) is also used by `shipping-service` — they are different Services, so no clash.

**Probes**

```yaml
readinessProbe:
  grpc: { port: 50051 }
  initialDelaySeconds: 3
  periodSeconds: 5
livenessProbe:
  grpc: { port: 50051 }
  periodSeconds: 10
  failureThreshold: 3
```

(The Node health handler implements `Check` only; `grpc:` probes only call `Check`.)

**Graceful shutdown:** on `SIGTERM` (or `SIGINT`) the service flushes OpenTelemetry/Pyroscope (at most 3 s), then exits with code 0. In-flight RPCs are not drained first. `terminationGracePeriodSeconds: 5` is enough.

**Security context**

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 100
  runAsGroup: 101
  allowPrivilegeEscalation: false
  capabilities: { drop: ["ALL"] }
  readOnlyRootFilesystem: true   # verified (no /tmp needed)
```

**Resources** — requests sized from measured idle usage in the test stack (see the chart's `values.yaml` for limits):

```yaml
resources:
  requests: { cpu: 100m, memory: 64Mi }
  limits:   { cpu: "500m", memory: 192Mi }
```

**Config / secrets:** none. Plain env only.

**Network policy:** only `checkout-service` should be allowed to reach port `50051`; this service handles card data.

**Telemetry:** pushed, not scraped — OTLP/gRPC to Alloy (`global.monitoring.otlpEndpoint`), profiles to Alloy `:4040`. Metrics carry `job="payment-service"` and `instance=<pod>`; no scrape annotations or `ServiceMonitor` are needed.

**Helm chart:** [`platform-demo-helm/payment-service`](https://github.com/platform-boutique/platform-demo-helm/tree/main/payment-service) (built on the shared `platform-common` library chart). It ships with HA defaults — 2 replicas,
HPA, PodDisruptionBudget, topology spread, NetworkPolicy, restricted pod security context, probes and the full env contract (see Configuration) —
and was verified in the earlier local phase on a 3-node kind cluster (since deleted) under the `restricted` Pod Security Standard; it has not been verified on EKS yet.

**Deployment and admission policies:** Argo CD deploys the chart from `platform-demo-helm` (`envs/<env>/values/payment-service.yaml` pins the image digest; promotion is a pull request). In the cluster Kyverno enforces, for this service: pods named `app.kubernetes.io/name: payment-service` that run under the ServiceAccount of the same name (Cilium derives the network identity from that label), an image from this repository pinned by digest and signed by our release pipeline, a read-only root filesystem, resource requests and a memory limit, readiness and liveness probes and no API token. The Helm CI evaluates the rendered chart against these policies before merge; see [`platform-demo-helm/policies`](https://github.com/platform-boutique/platform-demo-helm/tree/main/policies).

## Observability

| Signal | Implementation | Destination |
|---|---|---|
| **Traces** | OpenTelemetry `NodeSDK` + `GrpcInstrumentation`, OTLP/gRPC exporter (`BatchSpanProcessor`) | Alloy `:4317` → Tempo |
| **Metrics** | Hand-rolled RPC instruments (`GrpcInstrumentation` emits traces only) + Node runtime gauges, `PeriodicExportingMetricReader` over OTLP/gRPC every 15 s (replaces the Prometheus exporter) | Alloy → Mimir |
| **Logs** | `pino` JSON to stdout **and** `@opentelemetry/instrumentation-pino` forwarding records over OTLP/gRPC with trace ids | Alloy → Loki |
| **Profiles** | `@pyroscope/nodejs`, tagged with `version` | Alloy `:4040` → Pyroscope |

Metric names: `rpc_server_duration_seconds_{bucket,count,sum}` (buckets 1 ms … 10 s; the unit `s` yields the `_seconds` suffix), `rpc_server_requests_total`, `rpc_server_active_requests` (labels `rpc_system`, `rpc_service`, `rpc_method`, `rpc_grpc_status_code`), plus `nodejs_*` runtime gauges (heap, RSS, CPU, event-loop lag, active handles). The event-loop lag is sampled with Node's `monitorEventLoopDelay` histogram — the earlier self-rescheduling `setTimeout(0)` probe kept an idle pod at ~25 % CPU, which would have kept an HPA scaling out.

Every series carries `job="payment-service"` (from `service.name`) and `instance=<pod name>` (`service.instance.id`), which is what the Grafana dashboards select on. Logs land in Loki with `service_name="payment-service"` and trace/span ids, so a log line links to its trace.

## Running locally

Requirements: Node.js 22 (`.nvmrc`), Docker, [`grpcurl`](https://github.com/fullstorydev/grpcurl).

```bash
npm ci
npm run build && npm start
npm run dev                         # ts-node, no build step
npm test                            # jest unit tests
npm run lint && npm run typecheck

docker build -t payment-service .
docker run --rm -p 50051:50051 -e PORT=50051 payment-service
```

### Manual gRPC testing (no reflection — pass the proto)

```bash
grpcurl -plaintext -proto proto/payment.proto -d '{
  "amount": {"currency_code": "USD", "units": 50, "nanos": 0},
  "credit_card": {"credit_card_number": "4111111111111111", "credit_card_cvv": 123,
                  "credit_card_expiration_year": 2030, "credit_card_expiration_month": 12}
}' localhost:50051 hipstershop.PaymentService/Charge

# a declined card: FAILED_PRECONDITION "card_declined: ..."
grpcurl -plaintext -proto proto/payment.proto -d '{
  "amount": {"currency_code": "USD", "units": 50},
  "credit_card": {"credit_card_number": "4000000000000002", "credit_card_cvv": 123,
                  "credit_card_expiration_year": 2030, "credit_card_expiration_month": 12}
}' localhost:50051 hipstershop.PaymentService/Charge

# same transaction id -> same refund id
grpcurl -plaintext -proto proto/payment.proto -d '{"transaction_id": "abc"}' \
  localhost:50051 hipstershop.PaymentService/Refund

grpcurl -plaintext -proto proto/health.proto localhost:50051 grpc.health.v1.Health/Check
```

## Project structure

```
├── src/
│   ├── server.ts        # gRPC bootstrap, Check handler, wires handlers.ts
│   ├── handlers.ts      # Charge + Refund gRPC handlers, safe logging, status mapping
│   ├── charge.ts        # card validation, test-card outcomes, fake charge, card masking
│   ├── refund.ts        # simulated, idempotent refund
│   ├── errors.ts        # PaymentError classes, reason prefixes, toGrpcError
│   ├── logger.ts        # pino factory with card-field redaction
│   ├── telemetry.ts     # OTel SDK, RPC metrics, runtime gauges, Pyroscope, SIGTERM shutdown
│   ├── telemetry-config.ts # on/off contract from the environment (pure, tested)
│   └── types/simple-card-validator.d.ts
├── __tests__/           # jest: charge, refund, handlers (in-process gRPC server, log capture), telemetry on/off
├── proto/               # payment.proto, health.proto (loaded at runtime by @grpc/proto-loader; no codegen)
├── package.json / package-lock.json / tsconfig.json
├── Dockerfile
├── .dockerignore / .nvmrc / .eslintrc.cjs / .prettierrc / .trivyignore
└── docs/                # empty placeholder
```

## Known limitations

- Simulation only: no provider integration and no persistence. Each `Charge` yields a new transaction ID (no idempotency key); `Refund` cannot check that the transaction exists, or that the amount does not exceed it.
- Outcomes are keyed only on the documented test card numbers; there are no amount-based or random declines.
- The processing-error card blocks its call for ~3 s (a timer, not CPU); callers with a deadline below 3 s see `DEADLINE_EXCEEDED` instead of `UNAVAILABLE`.
- `checkout-service` does not call `Refund` yet and maps every payment error to `INTERNAL` (with the reason inside the message).
- `SIGTERM` exits after the telemetry flush without draining in-flight RPCs; the Docker `HEALTHCHECK` depends on `PORT` being set.
