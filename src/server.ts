import './fatal'; // first: uncaught errors, also while loading, are one JSON line
import { flushTelemetry, startRpcMetrics, telemetryConfig } from './telemetry'; // must be first — instruments before anything else loads
import path from 'path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { createLogger } from './logger';
import { makeHandlers } from './handlers';
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

function loadProto(protoPath: string) {
  const packageDefinition = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  return grpc.loadPackageDefinition(packageDefinition);
}

const paymentProto = (loadProto(PAYMENT_PROTO_PATH) as any).hipstershop;
const healthProto = (loadProto(HEALTH_PROTO_PATH) as any).grpc.health.v1;

// ---------------------------------------------------------------------------
// gRPC handlers (src/handlers.ts)
// ---------------------------------------------------------------------------

const handlers = makeHandlers({ logger, startRpcMetrics });

const health = createHealth();

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

function main(): void {
  const port = process.env.PORT ?? '50051';

  const server = new grpc.Server();
  server.addService(paymentProto.PaymentService.service, handlers);
  server.addService(healthProto.Health.service, { check: health.check });

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
