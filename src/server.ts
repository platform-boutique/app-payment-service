import './fatal'; // first: uncaught errors, also while loading, are one JSON line
import {
  flushTelemetry,
  recordPaymentOutcome,
  startRpcMetrics,
  telemetryConfig,
} from './telemetry'; // must be first — instruments before anything else loads
import path from 'path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { createLogger } from './logger';
import { makeHandlers } from './handlers';
import { addReflection } from './reflection';
import { createHealth, createShutdown, drainTimeoutFromEnv } from './lifecycle';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = createLogger(telemetryConfig.serviceName, undefined, {
  version: telemetryConfig.serviceVersion,
});

// ---------------------------------------------------------------------------
// Proto loading
// ---------------------------------------------------------------------------

const PAYMENT_PROTO_PATH = path.join(__dirname, '../proto/payment.proto');
const HEALTH_PROTO_PATH = path.join(__dirname, '../proto/health.proto');

function loadDefinition(protoPath: string) {
  return protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
}

const paymentDefinition = loadDefinition(PAYMENT_PROTO_PATH);
const healthDefinition = loadDefinition(HEALTH_PROTO_PATH);
const paymentProto = (grpc.loadPackageDefinition(paymentDefinition) as any).hipstershop;
const healthProto = (grpc.loadPackageDefinition(healthDefinition) as any).grpc.health.v1;

// ---------------------------------------------------------------------------
// gRPC handlers (src/handlers.ts)
// ---------------------------------------------------------------------------

const handlers = makeHandlers({ logger, startRpcMetrics, recordPaymentOutcome });

const health = createHealth();

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

function main(): void {
  const port = process.env.PORT ?? '50051';

  const server = new grpc.Server();
  server.addService(paymentProto.PaymentService.service, handlers);
  server.addService(healthProto.Health.service, { check: health.check });
  addReflection(server, paymentDefinition, healthDefinition);

  server.bindAsync(`[::]:${port}`, grpc.ServerCredentials.createInsecure(), (err, boundPort) => {
    if (err) {
      logger.error({ error: err }, 'Failed to bind gRPC server');
      process.exit(1);
    }
    logger.info(
      {
        commit: telemetryConfig.serviceCommit,
        port: boundPort,
        telemetry: telemetryConfig.telemetryReason,
        profiling: telemetryConfig.profilingReason,
      },
      'starting',
    );
  });

  // SIGTERM/SIGINT: health -> NOT_SERVING, wait for in-flight calls (tryShutdown, bounded),
  // flush telemetry, exit 0. A second signal is not intercepted and kills the process.
  const shutdown = createShutdown({
    server,
    health,
    flushTelemetry,
    exit: process.exit,
    logger,
    drainTimeoutMs: drainTimeoutFromEnv(),
  });
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

main();
