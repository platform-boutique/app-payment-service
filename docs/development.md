# Develop & test

## Checks and commands

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
