# payment-service

A gRPC service that "processes" payments for the platform-demo e-commerce platform. It validates a credit card (number checksum, brand, expiry), simulates declines and processor errors for documented test cards, returns a random transaction ID, and simulates refunds. **No real payment provider is involved and nothing is persisted** — it is a simulation. It is stateless, has no downstream dependencies, and is called only by `checkout-service`.

Part of the [platform-demo](https://github.com/platform-boutique) platform — microservices, observability (LGTM stack), GitOps (Argo CD), policy enforcement (Kyverno), infrastructure provisioning (Terraform) and an internal developer portal (Backstage). See the master `README.md` in the platform-demo root for the whole-system view.

## At a glance

| | |
|---|---|
| **Language / runtime** | TypeScript on Node.js 22 (`@grpc/grpc-js`) |
| **Image** | `mladenovskistefan/payment-service` |
| **Protocol / port** | gRPC (HTTP/2, plaintext) on `50051` |
| **Metrics** | Pushed over OTLP/gRPC to Alloy → Mimir every 15 s (no scrape endpoint). Dashboard names: `rpc_server_duration_seconds_{bucket,count,sum}`, `rpc_server_requests_total`, `rpc_server_active_requests`, `build_info`, `payment_charges_total` |
| **Health** | `grpc.health.v1.Health/Check` on `50051` — `SERVING`, `NOT_SERVING` during the shutdown drain |
| **State** | None |
| **Depends on** | Nothing (optional: OTLP collector, Pyroscope) |
| **Called by** | `checkout-service` (`Charge`; `Refund` when shipping fails after the charge) |
| **gRPC reflection** | Enabled (v1 and v1alpha, `@grpc/reflection`): `grpcurl -plaintext localhost:50051 list` works without the proto files |

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
3. CVV must be an integer 0-9999 (`credit_card_cvv` is an `int32`, so leading zeros are already lost: `012` arrives as 12, and a missing CVV arrives as 0; the check therefore rejects only values that cannot be a 3-4 digit CVV). The CVV is never logged or echoed in an error. Otherwise it is not verified.
4. Expiry month/year must not be in the past (a card expiring this month passes). "Now" comes from an injected clock (`src/clock.ts`, default: the system clock, read in the server's local time zone; the container runs in UTC), so the month boundary is testable without waiting.
5. `amount` must be present, `units` an integer that is not negative, `nanos` an integer 0-999999999.
6. The documented test cards below then produce their simulated outcome; every other valid card succeeds.

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
| Missing card, Luhn/length failure, unknown brand, expiration month outside 1-12, CVV outside 0-9999 | `INVALID_ARGUMENT` | `invalid_card` | `invalid_card: Credit card info is invalid` (CVV: `invalid_card: Credit card info is invalid: CVV must be 3 or 4 digits`) |
| Brand other than Visa/MasterCard | `INVALID_ARGUMENT` | `card_not_accepted` | `card_not_accepted: Sorry, we cannot process amex credit cards. Only VISA or MasterCard is accepted.` |
| Expired card | `INVALID_ARGUMENT` | `expired_card` | `expired_card: Your credit card (ending 1111) expired on 1/2025` |
| Declined | `FAILED_PRECONDITION` | `card_declined` | `card_declined: Your card (ending 0002) was declined by the issuer` |
| Insufficient funds | `FAILED_PRECONDITION` | `insufficient_funds` | `insufficient_funds: Your card (ending 9995) has insufficient funds` |
| Processor error (retry later) | `UNAVAILABLE` | `processing_error` | `processing_error: The payment processor could not complete the charge; please retry` |
| Charge with a missing, negative or malformed amount (non-integer units, nanos outside 0-999999999) | `INVALID_ARGUMENT` | `invalid_request` | `invalid_request: amount is required` / `amount must not be negative` / `amount.nanos must be an integer between 0 and 999999999` |
| Refund without `transaction_id`, negative or malformed refund amount | `INVALID_ARGUMENT` | `invalid_request` | `invalid_request: transaction_id is required` |
| Anything unexpected | `INTERNAL` | `internal_error` | `internal_error: unexpected payment failure` (the real exception text is never returned) |

`checkout-service` currently wraps every payment error as `INTERNAL "failed to charge card: ..."`, so the code is lost there but the reason prefix survives inside the message.

### Refund

Simulated: nothing is stored and the transaction is **not looked up** (the service keeps no state), so any non-empty `transaction_id` is accepted. Blank (or whitespace-only) → `INVALID_ARGUMENT`; a negative or malformed `amount` (units not an integer, nanos not an integer in 0-999999999) → `INVALID_ARGUMENT` (the same check as `Charge`); `amount` is otherwise not checked against the charge. `refund_id` is a UUID v5 of the trimmed transaction id, so **the same transaction id always returns the same refund id** (safe to retry), whatever the amount.

### Card data in logs and traces

No log line, error message or span attribute contains a full card number or the CVV; the most that is logged is the brand and the last four digits (`"card":{"brand":"visa","last4":"1111"}`). The request object is not logged. As defence in depth the pino loggers redact `credit_card`, `credit_card_number` and `credit_card_cvv` (top level and one/two levels deep) to `[REDACTED]`. The gRPC instrumentation records the status message as a span attribute (`grpc.error_message`), which is why error messages carry at most the last four digits; it records no request payload or metadata (no metadata capture is configured). `__tests__/handlers.test.ts` captures the logger and fails if a full number, its first six digits or the CVV appears in the logs of any charge path.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `50051` | gRPC listen port (the Docker `HEALTHCHECK` falls back to 50051 too) |
| `SHUTDOWN_DRAIN_TIMEOUT_MS` | `5000` | On `SIGTERM`/`SIGINT`: how long to wait for in-flight calls before cancelling them (positive integer; anything else uses the default) |
| `NODE_ENV` | `production` (set in image) | |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset (telemetry off) | OTLP/**gRPC** endpoint for **traces, metrics and logs**, an absolute `http(s)://host:port` URL, e.g. `http://alloy.monitoring.svc.cluster.local:4317`. Telemetry is on **only if** it is set to a valid URL; empty or malformed (`alloy:4317`, `http://`) means off, never a crash. The legacy `COLLECTOR_SERVICE_ADDR` and `ENABLE_TRACING` are no longer read |
| `OTEL_SDK_DISABLED` | unset | `true` (trimmed, any case) forces traces, metrics, logs **and profiling** off even if the endpoints are set |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `grpc` (fixed) | Not read: the service always exports OTLP/gRPC |
| `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG` | SDK default | Read by the OpenTelemetry Node SDK itself (not run here) |
| `OTEL_RESOURCE_ATTRIBUTES` | unset | Extra resource attributes, merged by the OpenTelemetry Node SDK (not run here); the five attributes below always come from the service |
| `OTEL_METRIC_EXPORT_INTERVAL` | `15000` | Milliseconds between metric pushes |
| `OTEL_SERVICE_NAME` | `payment-service` | `service.name`; becomes the Prometheus `job` and the Loki `service_name`; keep the default, dashboards depend on it |
| `SERVICE_VERSION` | `dev` | `service.version` resource attribute and the `version` field of every log line and Pyroscope tag |
| `SERVICE_COMMIT` | `unknown` | Commit id, logged once in the `starting` line (the image build does not set it yet) |
| `DEPLOYMENT_ENVIRONMENT` | `local` | `deployment.environment` resource attribute, Pyroscope tag `environment` |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warning` (or `warn`) or `error`, any case; anything else means `info` |
| `PYROSCOPE_ADDR` | unset (profiling off) | Absolute `http(s)` URL. Profiles use the Pyroscope SDK push protocol (**not** OTLP). Point it at Alloy (`http://alloy.monitoring.svc.cluster.local:4040`), which forwards to Pyroscope, or directly at Pyroscope. There is no default address: profiling is on **only if** it is set to a valid URL |
| `ENABLE_PROFILING` | unset | `0` or `false` forces profiling off even if `PYROSCOPE_ADDR` is set; `1` alone starts nothing |

Notes:

- There are **no secrets** and no external credentials: the service never talks to a real processor.
- Telemetry is **pushed**, not scraped: traces, metrics and logs share one OTLP/gRPC endpoint (Alloy); profiles go to Pyroscope (via Alloy). `service.instance.id` is the pod hostname, so replicas stay distinct in Mimir.
- The former Prometheus endpoint (`METRICS_PORT`) no longer exists. Logs keep going to stdout and are additionally exported over OTLP with trace ids.
- With nothing set the service starts with telemetry and profiling **off**, makes no outbound connections and logs no connection errors; the `starting` line says what is on (`"telemetry":"off: no OTEL_EXPORTER_OTLP_ENDPOINT","profiling":"off: no PYROSCOPE_ADDR"`). With telemetry off, logs still go to stdout (without trace ids). If an endpoint is set but unreachable the service keeps serving and, on `SIGTERM`, flushes for at most 3 s after the drain, so it exits well within 10 s (tested against a collector port that accepts connections and never answers).
- Resource attributes on every signal: `service.name`, `service.version`, `service.namespace=everly`, `deployment.environment`, `service.instance.id` (the hostname). Pyroscope tags: `service_name`, `version`, `environment`.
- Logs: one JSON object per line on stdout, fields `timestamp` (RFC3339 UTC, milliseconds), `severity` (`debug`, `info`, `warning`, `error`), `message`, `service`, `version`, `trace_id` and `span_id` (only while a span is active, i.e. while a gRPC call is handled) and `error` (a string, never a stack). Uncaught exceptions and unhandled rejections are one JSON line too, then exit code 1.

## Container image

Multi-stage [`Dockerfile`](Dockerfile):

| Stage | Base | What happens |
|---|---|---|
| builder | `node:22.22.2-alpine3.23` | `npm ci --ignore-scripts`, `npm run build` (tsc → `dist/`), `npm prune --omit=dev` |
| runtime | `node:22.22.2-alpine3.23` | copies `node_modules`, `dist/`, `proto/`; runs as non-root |

- **Entrypoint:** `node dist/server.js` (working dir `/app`).
- **User:** numeric `USER 10001:10001` (`appuser`/`appgroup`, created with these fixed ids; `id` in the container prints `uid=10001(appuser) gid=10001(appgroup)`). Build args `SERVICE_VERSION` (default `dev`) and `SERVICE_COMMIT` (default `unknown`) set the OCI labels `version`/`revision` (plus `source`, `licenses=Apache-2.0`) and the ENV of the same names.
- **EXPOSE:** `50051` only.
- **Docker `HEALTHCHECK`:** `grpc-js` client to `localhost:$PORT`. It uses `process.env.PORT || 50051`, the same default as the server (fixed in 719ce3d; the probe command was run against the server, the image itself was not rebuilt). Kubernetes ignores it.
- **Image size:** content size 72.5 MB (328 MB unpacked on disk), measured 2026-11-22.

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

**Graceful shutdown:** on `SIGTERM` (or `SIGINT`) the health service switches to `NOT_SERVING`, the server stops accepting calls and waits for in-flight RPCs (a `Charge` in progress is answered, not cut off) for at most `SHUTDOWN_DRAIN_TIMEOUT_MS` (default 5000; calls still running after that are cancelled), then OpenTelemetry/Pyroscope are flushed (at most 3 s) and the process exits with code 0. Worst case 8 s with the defaults, so set `terminationGracePeriodSeconds: 10` (the old value 5 can cut a slow charge). Verified with a built `dist/server.js`: a `Charge` with the 3 s processing-error card, `SIGTERM` after 0.5 s: the call was answered with `processing_error` at ~2.5 s, exit code 0; a new connection during the drain is refused, so a readiness probe fails. A second signal is not intercepted and kills the process at once.

**Security context**

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 10001
  runAsGroup: 10001
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
| **Logs** | `pino` JSON to stdout in the shared shape (`timestamp`, `severity`, `message`, `service`, `version`, `trace_id`, `span_id`, `error`; `trace_id`/`span_id` come from the active span via a pino `mixin`) **and** `@opentelemetry/instrumentation-pino` forwarding records over OTLP/gRPC (log correlation of that instrumentation is off, so there is no duplicate field) | stdout → Alloy → Loki; OTLP → Alloy → Loki |
| **Profiles** | `@pyroscope/nodejs`, only with `PYROSCOPE_ADDR`; tags `service_name`, `version`, `environment` | Alloy `:4040` → Pyroscope |

Metric names: `rpc_server_duration_seconds_{bucket,count,sum}` (buckets 1 ms … 10 s; the unit `s` yields the `_seconds` suffix), `rpc_server_requests_total`, `rpc_server_active_requests` (labels `rpc_system`, `rpc_service`, `rpc_method`, `rpc_grpc_status_code`), plus `nodejs_*` runtime gauges (heap, RSS, CPU, event-loop lag, active handles), `build_info{service,version,commit}` (always 1) and `payment_charges_total{outcome}` (one increment per finished Charge: `success` or the failure reason, i.e. `invalid_card`, `card_not_accepted`, `expired_card`, `card_declined`, `insufficient_funds`, `processing_error`, `invalid_request`, `internal_error`; no card data in labels). The event-loop lag is sampled with Node's `monitorEventLoopDelay` histogram — the earlier self-rescheduling `setTimeout(0)` probe kept an idle pod at ~25 % CPU, which would have kept an HPA scaling out.

Every series carries `job="payment-service"` (from `service.name`) and `instance=<pod name>` (`service.instance.id`), which is what the Grafana dashboards select on. Logs land in Loki with `service_name="payment-service"` and trace/span ids, so a log line links to its trace.

Metrics are pushed over OTLP (RED series above); this service has no Prometheus `/metrics` endpoint and none is planned (OBS-20 allows OTLP push for non-Go services). `service.version` comes from `SERVICE_VERSION` (default `dev`) and is logged once, with the commit, in the `starting` line.

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

### Manual gRPC testing (reflection is on; `-proto` also works)

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

## Develop

Requirements: Node.js 22 (`.nvmrc`; the table below was produced on 2026-11-22 on the host's Node 24.14.0 after `npm ci --ignore-scripts` and again in the CI image `node:22.22.2-alpine3.23`), Docker for the image, Python 3.12 for the docs check. The commands below are the ones the shared pipeline (`platform-demo-workflows`, `service-ci-node`) runs, so a failure can be reproduced without pushing. `Running locally` above has the run commands.

| Step | Command | Result on 2026-11-22 |
|---|---|---|
| Format | `npm run format:check` | run on Node 24.14.0 (host) and on Node 22.22.2 (`node:22.22.2-alpine3.23` container, full `npm ci`): all matched files use Prettier code style |
| Typecheck | `npm run typecheck` | run on both, passed |
| Lint | `npm run lint` | run on both, 0 errors, 4 warnings (`no-explicit-any`) |
| Build | `npm run build` | run on both, passed |
| Unit tests | `npm run test:ci` | run on both: 179 passed in 9 suites (about 16 s); coverage 97.0 % statements, 89.7 % branches (`--coverage`) |
| Dependency audit | `npm audit --audit-level=high --omit=dev` (CI) | run on both: found 0 vulnerabilities. The `uuid` advisory of 2026-11-21 (GHSA-w5hq-g745-h8pq) is fixed by `uuid` 11.1.1 (see `limitations.md`). The full `npm audit` (with dev dependencies) still lists 6 moderate findings, all one `minimatch` ReDoS advisory (GHSA-g3hv-75wg-m249) through the dev-only `@typescript-eslint` 7 packages: accepted exception, see `limitations.md` |
| SAST | `semgrep scan --config p/typescript --config p/nodejs --config p/secrets --error --metrics=off` (semgrep 1.180.0, as CI) | run, 111 rules on 59 files: 0 findings |
| Image | `docker build --platform linux/amd64 -t platform-demo/payment-service:local .` | run, passed; both `FROM` lines carry `@sha256:`; content size 72.5 MB (328 MB unpacked disk usage), user `10001:10001` |
| Image scan | `trivy image --severity CRITICAL,HIGH --exit-code 1 platform-demo/payment-service:local` (Trivy 0.76.1) | run, exit 0 (alpine 3.23.4 and all Node packages: 0 findings) |
| Container | `docker ps` health, whole shop `local/up.sh` + `local/smoke.sh` | run: the exec-form `HEALTHCHECK` reports `healthy`; `SMOKE PASSED` (87 PASS) three times in a row with this image in the shop (checkout charges a success card, a declined card and an insufficient-funds card each run); the service logged 31 info and 6 warning lines (the expected declines) and 0 error lines |
| Secret scan | `pre-commit run --all-files` (`.pre-commit-config.yaml`, gitleaks) or `gitleaks git --redact` | run with the gitleaks binary of the pre-commit cache (`gitleaks git --redact`, full history, 61 commits): no leaks found |
| Workflow lint | `actionlint` | run on 2026-11-21 (actionlint 1.7.12), no findings; not re-run for the workflows v3.8.0 pin change |
| Docs | `mkdocs build --strict` (mkdocs 1.6.1 + mkdocs-techdocs-core 1.7.1, Python 3.12 venv) and the link check `python3 -I tools/check-md-links.py .` from `platform-demo-workflows` (relative links in `README.md` and `docs/`) | run, both passed |

Not run: OTLP export against a real collector (the metrics are pushed, there is no scrape endpoint; the unit tests cover `payment_charges_total` and `build_info`), several replicas, `docker stop` timing of the final image.

## Project structure

```
├── src/
│   ├── server.ts        # gRPC bootstrap, wires handlers.ts and the shutdown
│   ├── lifecycle.ts     # health state, graceful shutdown (drain, NOT_SERVING, flush, exit)
│   ├── handlers.ts      # Charge + Refund gRPC handlers, safe logging, status mapping
│   ├── charge.ts        # card validation, test-card outcomes, fake charge, card masking
│   ├── clock.ts         # Clock (now, sleep) and the system clock; injected into charge() (CODE-07)
│   ├── refund.ts        # simulated, idempotent refund
│   ├── errors.ts        # PaymentError classes, reason prefixes, toGrpcError
│   ├── logger.ts        # pino factory: shared log shape, trace ids, card-field redaction
│   ├── fatal.ts         # uncaught exceptions / rejections as one JSON line, exit 1
│   ├── telemetry.ts     # OTel SDK, RPC metrics, runtime gauges, Pyroscope, telemetry flush
│   ├── telemetry-config.ts # on/off contract from the environment (pure, tested)
│   ├── metrics.ts       # build_info gauge, payment_charges_total{outcome}
│   ├── reflection.ts    # gRPC server reflection (v1, v1alpha)
│   └── types/simple-card-validator.d.ts
├── __tests__/           # jest (fake clock in __tests__/helpers, no real sleeps against timers): charge, refund, handlers (in-process gRPC server, log capture), telemetry on/off, log shape, real server process (JSON lines, trace ids, SIGTERM)
├── proto/               # payment.proto, health.proto (loaded at runtime by @grpc/proto-loader; no codegen)
├── package.json / package-lock.json / tsconfig.json
├── Dockerfile
├── .dockerignore / .nvmrc / .eslintrc.cjs / .prettierrc / .trivyignore
└── docs/                # TechDocs pages (mkdocs.yml in the root), docs/adr/ = decisions
```

## Known limitations

- Simulation only: no provider integration and no persistence. Each `Charge` yields a new transaction ID (no idempotency key); `Refund` cannot check that the transaction exists, or that the amount does not exceed it.
- Outcomes are keyed only on the documented test card numbers; there are no amount-based or random declines.
- The processing-error card blocks its call for ~3 s (a timer, not CPU); callers with a deadline below 3 s see `DEADLINE_EXCEEDED` instead of `UNAVAILABLE`.
- `checkout-service` calls `Refund` once, with the transaction id of the charge, when shipping fails after a successful `Charge` (no retry; if it fails the order says the refund is pending), and passes payment's gRPC codes through (see its README, error codes). Checked in its `origin/main` code on 2026-11-21; not run against this service for this table.
- On `SIGTERM` in-flight RPCs are drained for at most `SHUTDOWN_DRAIN_TIMEOUT_MS` (default 5 s); a call that outlasts it is cancelled. The `Check` health handler answers `NOT_SERVING` during the drain, but `Watch` is not implemented.
- Dependencies, 2026-11-22: `uuid` was raised from 9.0.1 to 11.1.1 to clear the moderate advisory GHSA-w5hq-g745-h8pq (v3/v5/v6 with a caller-supplied buffer; the service only calls `v4()` and `v5(name, namespace)`). 11.1.1 is the backport on the 11.x line that still works with `require`; the refund id of a given transaction id is unchanged.
- Accepted exception, 2026-11-22: `npm audit` (all dependencies) reports one moderate `minimatch` advisory (GHSA-g3hv-75wg-m249, ReDoS) through the dev-only `@typescript-eslint` 7 packages; the fix is a major bump of the lint toolchain (`@typescript-eslint` 8). It is not in the image (`npm prune --omit=dev`) and CI audits with `--omit=dev`, which finds 0. Revisit only if the lint toolchain is updated for another reason.
