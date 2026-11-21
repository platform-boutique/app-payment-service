# Develop & test

## Checks and commands

Requirements: Node.js 22 (`.nvmrc`; the table below was produced on the host's Node 24.14.0 after `npm ci --ignore-scripts`), Docker for the image, Python 3.12 for the docs check. The commands below are the ones the shared pipeline (`platform-demo-workflows`, `service-ci-node`) runs, so a failure can be reproduced without pushing. `Running locally` above has the run commands.

| Step | Command | Result on 2026-11-21 |
|---|---|---|
| Format | `npm run format:check` | run, all matched files use Prettier code style |
| Typecheck | `npm run typecheck` | run, passed |
| Lint | `npm run lint` | run, 0 errors, 4 warnings (`no-explicit-any`) |
| Build | `npm run build` | run, passed |
| Unit tests | `npm run test:ci` | run: 179 passed in 9 suites (about 80 s), on Node 24.14.0 of the host (the repo pins Node 22 in `.nvmrc`; not run on 22) |
| Dependency audit | `npm audit --audit-level=high --omit=dev` | run: exit 0 at `--audit-level=high`; it lists 1 moderate finding (`uuid` < 11.1.1, GHSA-w5hq-g745-h8pq, missing buffer bounds check in v3/v5/v6 when `buf` is provided; the fix is a breaking `uuid@14`), not changed here |
| Image | `docker build -t platform-demo/payment-service:local .` | not run today |
| Image scan | `trivy image --severity CRITICAL,HIGH --exit-code 1 platform-demo/payment-service:local` | not run today |
| Secret scan | `pre-commit run --all-files` (`.pre-commit-config.yaml`, gitleaks) or `gitleaks git --redact` | run with the gitleaks binary of the pre-commit cache (`gitleaks git --redact`, full history, 53 commits): no leaks found |
| Workflow lint | `actionlint` | run (actionlint 1.7.12), no findings |
| Docs | `mkdocs build --strict` (mkdocs 1.6.1 + mkdocs-techdocs-core 1.7.1, Python 3.12 venv) and the link check `python3 -I tools/check-md-links.py .` from `platform-demo-workflows` (relative links in `README.md` and `docs/`) | run, both passed |

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
│   └── types/simple-card-validator.d.ts
├── __tests__/           # jest (fake clock in __tests__/helpers, no real sleeps against timers): charge, refund, handlers (in-process gRPC server, log capture), telemetry on/off, log shape, real server process (JSON lines, trace ids, SIGTERM)
├── proto/               # payment.proto, health.proto (loaded at runtime by @grpc/proto-loader; no codegen)
├── package.json / package-lock.json / tsconfig.json
├── Dockerfile
├── .dockerignore / .nvmrc / .eslintrc.cjs / .prettierrc / .trivyignore
└── docs/                # TechDocs pages (mkdocs.yml in the root), docs/adr/ = decisions
```
