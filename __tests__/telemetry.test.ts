import { resolveTelemetryConfig } from '../src/telemetry-config';

// ---------------------------------------------------------------------------
// Contract (pure)
// ---------------------------------------------------------------------------

describe('resolveTelemetryConfig()', () => {
  it('everything unset -> telemetry and profiling off', () => {
    const c = resolveTelemetryConfig({});
    expect(c.otlpEndpoint).toBeNull();
    expect(c.pyroscopeAddr).toBeNull();
    expect(c.telemetryReason).toMatch(/^off/);
    expect(c.profilingReason).toMatch(/^off/);
    expect(c.serviceName).toBe('payment-service');
    expect(c.metricExportIntervalMs).toBe(15000);
  });

  it('empty values count as unset', () => {
    const c = resolveTelemetryConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: '',
      COLLECTOR_SERVICE_ADDR: ' ',
      PYROSCOPE_ADDR: '',
    });
    expect(c.otlpEndpoint).toBeNull();
    expect(c.pyroscopeAddr).toBeNull();
  });

  it('OTEL_EXPORTER_OTLP_ENDPOINT turns telemetry on', () => {
    const c = resolveTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://alloy:4317' });
    expect(c.otlpEndpoint).toBe('http://alloy:4317');
  });

  it('legacy COLLECTOR_SERVICE_ADDR (host:port) turns it on, the new variable wins', () => {
    expect(resolveTelemetryConfig({ COLLECTOR_SERVICE_ADDR: 'alloy:4317' }).otlpEndpoint).toBe(
      'http://alloy:4317',
    );
    expect(
      resolveTelemetryConfig({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://a:4317',
        COLLECTOR_SERVICE_ADDR: 'b:4317',
      }).otlpEndpoint,
    ).toBe('http://a:4317');
  });

  it.each([
    [{ OTEL_SDK_DISABLED: 'true' }, /OTEL_SDK_DISABLED/],
    [{ OTEL_SDK_DISABLED: 'TRUE' }, /OTEL_SDK_DISABLED/],
    [{ ENABLE_TRACING: '0' }, /ENABLE_TRACING/],
  ])('%j forces telemetry off even with an endpoint', (extra, reason) => {
    const c = resolveTelemetryConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://alloy:4317',
      ...extra,
    });
    expect(c.otlpEndpoint).toBeNull();
    expect(c.telemetryReason).toMatch(reason);
  });

  it('OTEL_SDK_DISABLED=false and ENABLE_TRACING=1 keep it on', () => {
    const c = resolveTelemetryConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://alloy:4317',
      OTEL_SDK_DISABLED: 'false',
      ENABLE_TRACING: '1',
    });
    expect(c.otlpEndpoint).toBe('http://alloy:4317');
  });

  it('profiling: on with PYROSCOPE_ADDR, off with ENABLE_PROFILING=0', () => {
    expect(resolveTelemetryConfig({ PYROSCOPE_ADDR: 'http://alloy:4040' }).pyroscopeAddr).toBe(
      'http://alloy:4040',
    );
    const off = resolveTelemetryConfig({
      PYROSCOPE_ADDR: 'http://alloy:4040',
      ENABLE_PROFILING: '0',
    });
    expect(off.pyroscopeAddr).toBeNull();
    expect(off.profilingReason).toMatch(/ENABLE_PROFILING/);
  });

  it('profiling is independent of the OTLP switches', () => {
    const c = resolveTelemetryConfig({
      PYROSCOPE_ADDR: 'http://p:4040',
      OTEL_SDK_DISABLED: 'true',
    });
    expect(c.pyroscopeAddr).toBe('http://p:4040');
  });
});

// ---------------------------------------------------------------------------
// The telemetry module itself, with the SDK and profiler mocked
// ---------------------------------------------------------------------------

const TELEMETRY_VARS = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'COLLECTOR_SERVICE_ADDR',
  'OTEL_SDK_DISABLED',
  'ENABLE_TRACING',
  'PYROSCOPE_ADDR',
  'ENABLE_PROFILING',
];

function loadTelemetry(env: Record<string, string>) {
  const saved = { ...process.env };
  for (const k of TELEMETRY_VARS) delete process.env[k];
  Object.assign(process.env, env);

  const nodeSdk = { start: jest.fn(), shutdown: jest.fn().mockResolvedValue(undefined) };
  const NodeSDK = jest.fn(() => nodeSdk);
  const Pyroscope = {
    init: jest.fn(),
    start: jest.fn(),
    stop: jest.fn().mockResolvedValue(undefined),
  };
  jest.doMock('@opentelemetry/sdk-node', () => ({ NodeSDK }));
  jest.doMock('@pyroscope/nodejs', () => ({ __esModule: true, default: Pyroscope }));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod: any;
  jest.isolateModules(() => {
    mod = require('../src/telemetry');
  });
  process.env = saved;
  return { mod, NodeSDK, nodeSdk, Pyroscope };
}

afterEach(() => {
  jest.dontMock('@opentelemetry/sdk-node');
  jest.dontMock('@pyroscope/nodejs');
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
});

describe('telemetry module', () => {
  it('off path: with everything unset no SDK or profiler is started, metrics are no-ops', async () => {
    const { mod, NodeSDK, Pyroscope } = loadTelemetry({});
    expect(NodeSDK).not.toHaveBeenCalled();
    expect(Pyroscope.init).not.toHaveBeenCalled();
    expect(Pyroscope.start).not.toHaveBeenCalled();
    expect(mod.sdk).toBeNull();
    expect(() => mod.startRpcMetrics('Charge')(0)).not.toThrow();

    const exit = jest.fn();
    await mod.shutdown(exit);
    expect(exit).toHaveBeenCalledWith(0);
    expect(Pyroscope.stop).not.toHaveBeenCalled();
  });

  it('on path: endpoint and Pyroscope set -> both started, shutdown flushes then exits 0', async () => {
    const { mod, NodeSDK, nodeSdk, Pyroscope } = loadTelemetry({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9',
      PYROSCOPE_ADDR: 'http://127.0.0.1:9',
    });
    expect(NodeSDK).toHaveBeenCalledTimes(1);
    expect(nodeSdk.start).toHaveBeenCalledTimes(1);
    expect(Pyroscope.init).toHaveBeenCalledWith(
      expect.objectContaining({ serverAddress: 'http://127.0.0.1:9' }),
    );

    const exit = jest.fn();
    await mod.shutdown(exit);
    expect(nodeSdk.shutdown).toHaveBeenCalled();
    expect(Pyroscope.stop).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('a hanging flush is cut off and the process still exits 0', async () => {
    const { mod, nodeSdk } = loadTelemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9' });
    nodeSdk.shutdown.mockReturnValue(new Promise(() => undefined));
    jest.useFakeTimers();
    try {
      const exit = jest.fn();
      const p = mod.shutdown(exit);
      await jest.advanceTimersByTimeAsync(mod.SHUTDOWN_FLUSH_TIMEOUT_MS);
      await p;
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('OTEL_SDK_DISABLED=true keeps the SDK off despite an endpoint', () => {
    const { NodeSDK } = loadTelemetry({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9',
      OTEL_SDK_DISABLED: 'true',
    });
    expect(NodeSDK).not.toHaveBeenCalled();
  });
});
