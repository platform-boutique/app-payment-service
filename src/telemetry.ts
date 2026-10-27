import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { GrpcInstrumentation } from '@opentelemetry/instrumentation-grpc';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import * as api from '@opentelemetry/api';
import { hostname } from 'os';
import { monitorEventLoopDelay } from 'perf_hooks';
import Pyroscope from '@pyroscope/nodejs';

import { resolveTelemetryConfig } from './telemetry-config';

// Telemetry contract: see telemetry-config.ts. With nothing set, no SDK and no
// profiler start, so the service makes no outbound connections.
export const telemetryConfig = resolveTelemetryConfig(process.env);
const SERVICE_NAME = telemetryConfig.serviceName;
const SERVICE_VERSION = telemetryConfig.serviceVersion;

function startSdk(endpoint: string): NodeSDK {
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: SERVICE_NAME,
    [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
    // Distinguishes replicas: in Kubernetes the hostname is the pod name.
    'service.instance.id': process.env.HOSTNAME ?? hostname(),
  });

  // All three signals are pushed over OTLP/gRPC to the collector (Alloy), which fans out
  // to Tempo (traces), Mimir (metrics) and Loki (logs).
  const nodeSdk = new NodeSDK({
    resource,
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: endpoint }))],
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: endpoint }),
        exportIntervalMillis: telemetryConfig.metricExportIntervalMs,
      }),
    ],
    logRecordProcessors: [
      new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: endpoint }) }),
    ],
    // PinoInstrumentation forwards pino records to the OTel logs pipeline and adds trace/span ids.
    instrumentations: [new GrpcInstrumentation(), new PinoInstrumentation()],
  });
  // Started immediately on import — server.ts imports this module first, so the
  // instrumentation patches @grpc/grpc-js and pino before they are loaded.
  nodeSdk.start();
  return nodeSdk;
}

const sdk: NodeSDK | null = telemetryConfig.otlpEndpoint
  ? startSdk(telemetryConfig.otlpEndpoint)
  : null;

// ---------------------------------------------------------------------------
// Custom gRPC server metrics
// (With telemetry off the global meter is the OTel no-op meter, so these cost nothing.)
// The Node.js GrpcInstrumentation only produces traces, not metrics.
// We create manual instruments that match the OTel RPC semantic conventions
// so the Grafana dashboard can query them.
// ---------------------------------------------------------------------------

const meter = api.metrics.getMeter('payment-service-grpc');
const runtimeMeter = api.metrics.getMeter('payment-service-runtime');

const rpcServerDuration = meter.createHistogram('rpc_server_duration', {
  description: 'Duration of inbound gRPC calls in seconds',
  unit: 's',
  advice: {
    explicitBucketBoundaries: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  },
});

const rpcServerRequestsTotal = meter.createCounter('rpc_server_requests_total', {
  description: 'Total number of inbound gRPC calls',
});

const rpcServerActiveRequests = meter.createUpDownCounter('rpc_server_active_requests', {
  description: 'Number of in-flight gRPC calls',
});

// ---------------------------------------------------------------------------
// Node.js runtime metrics (observable gauges scraped on each /metrics request)
// ---------------------------------------------------------------------------

runtimeMeter
  .createObservableGauge('nodejs_process_resident_memory_bytes', {
    description: 'Resident memory size in bytes',
    unit: 'By',
  })
  .addCallback((obs) => {
    obs.observe(process.memoryUsage().rss);
  });

runtimeMeter
  .createObservableGauge('nodejs_heap_size_total_bytes', {
    description: 'V8 heap total size in bytes',
    unit: 'By',
  })
  .addCallback((obs) => {
    obs.observe(process.memoryUsage().heapTotal);
  });

runtimeMeter
  .createObservableGauge('nodejs_heap_size_used_bytes', {
    description: 'V8 heap used size in bytes',
    unit: 'By',
  })
  .addCallback((obs) => {
    obs.observe(process.memoryUsage().heapUsed);
  });

runtimeMeter
  .createObservableGauge('nodejs_external_memory_bytes', {
    description: 'V8 external memory in bytes',
    unit: 'By',
  })
  .addCallback((obs) => {
    obs.observe(process.memoryUsage().external);
  });

runtimeMeter
  .createObservableGauge('nodejs_array_buffers_bytes', {
    description: 'Memory allocated for ArrayBuffers and SharedArrayBuffers',
    unit: 'By',
  })
  .addCallback((obs) => {
    obs.observe(process.memoryUsage().arrayBuffers);
  });

runtimeMeter
  .createObservableGauge('nodejs_process_cpu_user_seconds', {
    description: 'CPU user time in seconds',
    unit: 's',
  })
  .addCallback((obs) => {
    obs.observe(process.cpuUsage().user / 1e6);
  });

runtimeMeter
  .createObservableGauge('nodejs_process_cpu_system_seconds', {
    description: 'CPU system time in seconds',
    unit: 's',
  })
  .addCallback((obs) => {
    obs.observe(process.cpuUsage().system / 1e6);
  });

runtimeMeter
  .createObservableGauge('nodejs_process_uptime_seconds', {
    description: 'Process uptime in seconds',
    unit: 's',
  })
  .addCallback((obs) => {
    obs.observe(process.uptime());
  });

// Event loop lag — sampled by Node's built-in histogram (cheap; a self-rescheduling setTimeout(0)
// loop would keep the process at ~25% CPU even when idle). Reported value = mean delay since the last scrape.
const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
eventLoopDelay.enable();

runtimeMeter
  .createObservableGauge('nodejs_eventloop_lag_seconds', {
    description: 'Event loop lag in seconds',
    unit: 's',
  })
  .addCallback((obs) => {
    const meanNs = eventLoopDelay.count > 0 ? eventLoopDelay.mean : 0;
    eventLoopDelay.reset();
    obs.observe(meanNs / 1e9);
  });

// Active handles and requests
runtimeMeter
  .createObservableGauge('nodejs_active_handles_total', {
    description: 'Number of active handles',
  })
  .addCallback((obs) => {
    obs.observe((process as any)._getActiveHandles?.().length ?? 0);
  });

runtimeMeter
  .createObservableGauge('nodejs_active_requests_total', {
    description: 'Number of active requests',
  })
  .addCallback((obs) => {
    obs.observe((process as any)._getActiveRequests?.().length ?? 0);
  });

/**
 * Call this at the start of each gRPC handler. Returns a function to call
 * when the handler finishes (pass the gRPC status code).
 */
export function startRpcMetrics(method: string): (grpcStatusCode: number) => void {
  const startTime = process.hrtime.bigint();
  const attrs = {
    rpc_system: 'grpc',
    rpc_service: 'hipstershop.PaymentService',
    rpc_method: method,
  };

  rpcServerActiveRequests.add(1, attrs);

  return (grpcStatusCode: number) => {
    const elapsed = Number(process.hrtime.bigint() - startTime) / 1e9; // seconds
    const finalAttrs = { ...attrs, rpc_grpc_status_code: String(grpcStatusCode) };

    rpcServerDuration.record(elapsed, finalAttrs);
    rpcServerRequestsTotal.add(1, finalAttrs);
    rpcServerActiveRequests.add(-1, attrs);
  };
}

// --- Pyroscope continuous profiling (only when configured) ---
if (telemetryConfig.pyroscopeAddr) {
  Pyroscope.init({
    serverAddress: telemetryConfig.pyroscopeAddr,
    appName: SERVICE_NAME,
    tags: { version: SERVICE_VERSION },
  });
  Pyroscope.start();
}

/** Upper bound for flushing telemetry on shutdown. */
export const SHUTDOWN_FLUSH_TIMEOUT_MS = 3000;
let flushing: Promise<void> | null = null;

/**
 * Flushes telemetry and the profiler, bounded by SHUTDOWN_FLUSH_TIMEOUT_MS.
 * Idempotent (a second call returns the first call's promise) and never
 * rejects: flush failures are ignored, they must not keep the process alive.
 * Does not exit and does not install signal handlers: the process lifecycle
 * (drain in-flight RPCs, health, exit) lives in lifecycle.ts / server.ts.
 */
export function flushTelemetry(): Promise<void> {
  flushing ??= (async () => {
    const flush = Promise.allSettled([
      sdk ? sdk.shutdown() : Promise.resolve(),
      telemetryConfig.pyroscopeAddr ? Promise.resolve(Pyroscope.stop()) : Promise.resolve(),
    ]);
    await Promise.race([
      flush,
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_FLUSH_TIMEOUT_MS).unref()),
    ]);
  })();
  return flushing;
}

/** Flushes telemetry, then exits with code 0 (used when there is no server to drain). */
export async function shutdown(exit: (code: number) => void = process.exit): Promise<void> {
  await flushTelemetry();
  exit(0);
}

export { sdk };
