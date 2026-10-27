/**
 * Uniform telemetry contract (pure: reads only the env object it is given).
 *
 * - Traces, metrics and logs over OTLP are ON only if OTEL_EXPORTER_OTLP_ENDPOINT
 *   (or the legacy COLLECTOR_SERVICE_ADDR, host:port) is set and non-empty.
 *   OTEL_SDK_DISABLED=true or ENABLE_TRACING=0 force them off.
 * - Profiling (Pyroscope) is ON only if PYROSCOPE_ADDR is set and non-empty and
 *   ENABLE_PROFILING is not 0.
 *
 * With nothing set, both are off and nothing tries to connect anywhere.
 */
export interface TelemetryConfig {
  serviceName: string;
  serviceVersion: string;
  /** OTLP/gRPC endpoint, or null when telemetry is off. */
  otlpEndpoint: string | null;
  /** Pyroscope server address, or null when profiling is off. */
  pyroscopeAddr: string | null;
  metricExportIntervalMs: number;
  /** Human-readable reason for the on/off decisions, for the startup log. */
  telemetryReason: string;
  profilingReason: string;
}

type Env = Record<string, string | undefined>;

const nonEmpty = (v: string | undefined): string | undefined =>
  v !== undefined && v.trim() !== '' ? v.trim() : undefined;

const isOff = (v: string | undefined): boolean =>
  v !== undefined && ['0', 'false'].includes(v.trim().toLowerCase());

export function resolveTelemetryConfig(env: Env): TelemetryConfig {
  const endpoint =
    nonEmpty(env.OTEL_EXPORTER_OTLP_ENDPOINT) ??
    (nonEmpty(env.COLLECTOR_SERVICE_ADDR)
      ? `http://${nonEmpty(env.COLLECTOR_SERVICE_ADDR)}`
      : undefined);

  let otlpEndpoint: string | null = null;
  let telemetryReason: string;
  if ((env.OTEL_SDK_DISABLED ?? '').trim().toLowerCase() === 'true') {
    telemetryReason = 'off: OTEL_SDK_DISABLED=true';
  } else if (isOff(env.ENABLE_TRACING)) {
    telemetryReason = 'off: ENABLE_TRACING=0';
  } else if (!endpoint) {
    telemetryReason = 'off: no OTEL_EXPORTER_OTLP_ENDPOINT / COLLECTOR_SERVICE_ADDR';
  } else {
    otlpEndpoint = endpoint;
    telemetryReason = `on: ${endpoint}`;
  }

  const pyro = nonEmpty(env.PYROSCOPE_ADDR);
  let pyroscopeAddr: string | null = null;
  let profilingReason: string;
  if (isOff(env.ENABLE_PROFILING)) {
    profilingReason = 'off: ENABLE_PROFILING=0';
  } else if (!pyro) {
    profilingReason = 'off: no PYROSCOPE_ADDR';
  } else {
    pyroscopeAddr = pyro;
    profilingReason = `on: ${pyro}`;
  }

  const interval = parseInt(env.OTEL_METRIC_EXPORT_INTERVAL ?? '', 10);
  return {
    serviceName: nonEmpty(env.OTEL_SERVICE_NAME) ?? 'payment-service',
    serviceVersion: nonEmpty(env.SERVICE_VERSION) ?? '1.0.0',
    otlpEndpoint,
    pyroscopeAddr,
    metricExportIntervalMs: Number.isFinite(interval) && interval > 0 ? interval : 15000,
    telemetryReason,
    profilingReason,
  };
}
