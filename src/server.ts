import { startRpcMetrics } from './telemetry'; // must be first — instruments before anything else loads
import path from 'path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { createLogger } from './logger';
import { makeHandlers } from './handlers';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = createLogger('payment-service');

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

function check(
  _call: grpc.ServerUnaryCall<unknown, unknown>,
  callback: grpc.sendUnaryData<{ status: string }>,
): void {
  callback(null, { status: 'SERVING' });
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

function main(): void {
  const port = process.env.PORT ?? '50051';

  const server = new grpc.Server();
  server.addService(paymentProto.PaymentService.service, handlers);
  server.addService(healthProto.Health.service, { check });

  server.bindAsync(`[::]:${port}`, grpc.ServerCredentials.createInsecure(), (err, boundPort) => {
    if (err) {
      logger.error({ err }, 'Failed to bind gRPC server');
      process.exit(1);
    }
    logger.info({ port: boundPort }, 'PaymentService gRPC server started');
  });
}

main();
