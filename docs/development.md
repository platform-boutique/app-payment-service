# Develop & test

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
│   ├── telemetry.ts     # OTel SDK, Prometheus exporter, RPC metrics, runtime gauges, Pyroscope
│   └── types/simple-card-validator.d.ts
├── __tests__/           # jest: charge, refund, handlers (in-process gRPC server, log capture)
├── proto/               # payment.proto, health.proto (loaded at runtime by @grpc/proto-loader; no codegen)
├── package.json / package-lock.json / tsconfig.json
├── Dockerfile
├── .dockerignore / .nvmrc / .eslintrc.cjs / .prettierrc / .trivyignore
└── docs/                # empty placeholder
```
