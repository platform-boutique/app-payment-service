import { pyroscopeTags, resolveTelemetryConfig, resourceAttributes } from '../src/telemetry-config';

// ---------------------------------------------------------------------------
// Contract (pure)
// ---------------------------------------------------------------------------

const EP = 'http://alloy:4317';
const PY = 'http://pyroscope:4040';

describe('resolveTelemetryConfig() env matrix', () => {
  it.each([
    [{}, null],
    [{ OTEL_EXPORTER_OTLP_ENDPOINT: '' }, null],
    [{ OTEL_EXPORTER_OTLP_ENDPOINT: '   ' }, null],
    [{ OTEL_EXPORTER_OTLP_ENDPOINT: EP }, EP],
    [{ OTEL_EXPORTER_OTLP_ENDPOINT: ` ${EP} ` }, EP],
    [
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com:4317' },
      'https://otel.example.com:4317',
    ],
    // malformed: off, never a crash
    [{ OTEL_EXPORTER_OTLP_ENDPOINT: 'alloy:4317' }, null],
    [{ OTEL_EXPORTER_OTLP_ENDPOINT: 'alloy' }, null],
    [{ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://' }, null],
    [{ OTEL_EXPORTER_OTLP_ENDPOINT: 'ftp://alloy:4317' }, null],
    [{ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://alloy:99999' }, null],
    [{ OTEL_EXPORTER_OTLP_ENDPOINT: 'not a url' }, null],
    // OTEL_SDK_DISABLED=true (trimmed, any case) forces off
    [{ OTEL_EXPORTER_OTLP_ENDPOINT: EP, OTEL_SDK_DISABLED: 'true' }, null],
    [{ OTEL_EXPORTER_OTLP_ENDPOINT: EP, OTEL_SDK_DISABLED: 'TRUE' }, null],
    [{ OTEL_EXPORTER_OTLP_ENDPOINT: EP, OTEL_SDK_DISABLED: ' True ' }, null],
    [{ OTEL_EXPORTER_OTLP_ENDPOINT: EP, OTEL_SDK_DISABLED: 'false' }, EP],
    [{ OTEL_EXPORTER_OTLP_ENDPOINT: EP, OTEL_SDK_DISABLED: '' }, EP],
    // the legacy switches are gone
    [{ COLLECTOR_SERVICE_ADDR: 'alloy:4317' }, null],
    [{ COLLECTOR_SERVICE_ADDR: 'b:4317', OTEL_EXPORTER_OTLP_ENDPOINT: EP }, EP],
    [{ OTEL_EXPORTER_OTLP_ENDPOINT: EP, ENABLE_TRACING: '0' }, EP],
  ])('%j -> otlpEndpoint %j', (env, expected) => {
    expect(resolveTelemetryConfig(env).otlpEndpoint).toBe(expected);
  });

  it.each([
    [{}, null],
    [{ PYROSCOPE_ADDR: '' }, null],
    [{ PYROSCOPE_ADDR: PY }, PY],
    [{ PYROSCOPE_ADDR: PY, ENABLE_PROFILING: '1' }, PY],
    [{ ENABLE_PROFILING: '1' }, null], // no default address
    [{ PYROSCOPE_ADDR: PY, ENABLE_PROFILING: '0' }, null],
    [{ PYROSCOPE_ADDR: 'pyroscope:4040' }, null],
    [{ PYROSCOPE_ADDR: 'http://' }, null],
    [{ PYROSCOPE_ADDR: PY, OTEL_SDK_DISABLED: 'true' }, null], // forces everything off
    [{ PYROSCOPE_ADDR: PY, OTEL_SDK_DISABLED: 'false' }, PY],
  ])('%j -> pyroscopeAddr %j', (env, expected) => {
    expect(resolveTelemetryConfig(env).pyroscopeAddr).toBe(expected);
  });

  it('defaults', () => {
    const c = resolveTelemetryConfig({ HOSTNAME: 'pod-1' });
    expect(c.serviceName).toBe('payment-service');
    expect(c.serviceVersion).toBe('dev');
    expect(c.serviceCommit).toBe('unknown');
    expect(c.metricExportIntervalMs).toBe(15000);
    expect(c.telemetryReason).toMatch(/^off/);
    expect(c.profilingReason).toMatch(/^off/);
  });

  it('resource attributes and Pyroscope tags', () => {
    const c = resolveTelemetryConfig({ HOSTNAME: 'pod-1' });
    expect(resourceAttributes(c)).toEqual({
      'service.name': 'payment-service',
      'service.version': 'dev',
      'service.namespace': 'everly',
      'deployment.environment': 'local',
      'service.instance.id': 'pod-1',
    });
    const d = resolveTelemetryConfig({
      SERVICE_VERSION: '1.2.3',
      DEPLOYMENT_ENVIRONMENT: 'dev',
      HOSTNAME: 'pod-2',
    });
    expect(resourceAttributes(d)['service.version']).toBe('1.2.3');
    expect(resourceAttributes(d)['deployment.environment']).toBe('dev');
    expect(pyroscopeTags(d)).toEqual({
      service_name: 'payment-service',
      version: '1.2.3',
      environment: 'dev',
    });
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
  'DEPLOYMENT_ENVIRONMENT',
  'SERVICE_VERSION',
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

  it('does not install its own SIGTERM/SIGINT handlers (server.ts drains RPCs first)', () => {
    const before = [process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')];
    loadTelemetry({});
    expect([process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')]).toEqual(before);
  });

  it('flushTelemetry flushes once and never exits', async () => {
    const { mod, nodeSdk } = loadTelemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9' });
    await Promise.all([mod.flushTelemetry(), mod.flushTelemetry()]);
    expect(nodeSdk.shutdown).toHaveBeenCalledTimes(1);
  });

  it('OTEL_SDK_DISABLED=true keeps the SDK off despite an endpoint', () => {
    const { NodeSDK } = loadTelemetry({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9',
      OTEL_SDK_DISABLED: 'true',
    });
    expect(NodeSDK).not.toHaveBeenCalled();
  });
});
