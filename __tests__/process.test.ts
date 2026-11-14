/**
 * The REAL server in a child process (ts-node, transpile only): JSON log shape, trace correlation of the logs of a
 * request with an incoming traceparent, JSON startup failure, SIGTERM exit. Telemetry ON points at a port where
 * nobody listens: the service must start, serve and exit anyway.
 */
import { spawn } from 'child_process';
import net from 'net';
import path from 'path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const ROOT = path.join(__dirname, '..');
const TELEMETRY_VARS = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'COLLECTOR_SERVICE_ADDR',
  'OTEL_SDK_DISABLED',
  'ENABLE_TRACING',
  'PYROSCOPE_ADDR',
  'ENABLE_PROFILING',
  'LOG_LEVEL',
  'SERVICE_VERSION',
];

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

function start(extra: Record<string, string>) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of TELEMETRY_VARS) delete env[k];
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    process.execPath,
    ['-r', 'ts-node/register/transpile-only', 'src/server.ts'],
    { cwd: ROOT, env: { ...env, ...extra } },
  );
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  const waitFor = async (text: string, ms = 30000) => {
    const end = performance.now() + ms;
    while (!out.includes(text)) {
      if (performance.now() > end)
        throw new Error(`timeout waiting for ${text}; out=${out} err=${err}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const lines = () =>
    out
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l)); // every line must be JSON
  return { child, exited, waitFor, lines, stderr: () => err };
}

function client(port: number) {
  const def = protoLoader.loadSync(path.join(ROOT, 'proto/payment.proto'), {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proto = grpc.loadPackageDefinition(def) as any;
  return new proto.hipstershop.PaymentService(
    `127.0.0.1:${port}`,
    grpc.credentials.createInsecure(),
  );
}

function chargeReq() {
  return {
    amount: { currency_code: 'USD', units: 1, nanos: 0 },
    credit_card: {
      credit_card_number: '4432-8015-6152-0454',
      credit_card_cvv: 123,
      credit_card_expiration_year: new Date().getFullYear() + 2,
      credit_card_expiration_month: 12,
    },
  };
}

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';

describe('real server process', () => {
  it('telemetry off: JSON shape without trace ids, SIGTERM exits 0', async () => {
    const port = await freePort();
    const p = start({ PORT: String(port) });
    await p.waitFor('"starting"');
    const c = client(port);
    await new Promise<void>((resolve, reject) =>
      c.charge(chargeReq(), (e: Error | null) => (e ? reject(e) : resolve())),
    );
    c.close();
    p.child.kill('SIGTERM');
    expect(await p.exited).toBe(0);
    const lines = p.lines();
    for (const l of lines) {
      expect(l).toEqual(
        expect.objectContaining({
          timestamp: expect.stringMatching(/Z$/),
          service: 'payment-service',
          version: 'dev',
        }),
      );
      expect(['debug', 'info', 'warning', 'error']).toContain(l.severity);
      expect(l).not.toHaveProperty('trace_id');
      expect(l).not.toHaveProperty('time');
    }
    const starting = lines.find((l) => l.message === 'starting');
    expect(starting).toMatchObject({ commit: 'unknown', telemetry: expect.stringMatching(/^off/) });
    expect(p.stderr()).toBe('');
  }, 60000);

  it('telemetry on (collector port closed): request logs carry the incoming trace id, exit within 10 s', async () => {
    const port = await freePort();
    const dead = await freePort();
    const p = start({
      PORT: String(port),
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${dead}`,
    });
    await p.waitFor('"starting"');
    const c = client(port);
    const md = new grpc.Metadata();
    md.set('traceparent', `00-${TRACE_ID}-b7ad6b7169203331-01`);
    await new Promise<void>((resolve, reject) =>
      c.charge(chargeReq(), md, (e: Error | null) => (e ? reject(e) : resolve())),
    );
    c.close();
    const started = performance.now(); // monotonic: the host wall clock jumps
    p.child.kill('SIGTERM');
    expect(await p.exited).toBe(0);
    expect(performance.now() - started).toBeLessThan(10000);
    const lines = p.lines();
    const invoked = lines.find((l) => l.message === 'PaymentService#Charge invoked');
    const processed = lines.find((l) => l.message === 'Transaction processed');
    expect(invoked.trace_id).toBe(TRACE_ID);
    expect(processed.trace_id).toBe(TRACE_ID);
    expect(processed.span_id).toMatch(/^[0-9a-f]{16}$/);
    expect(processed.span_id).not.toBe('b7ad6b7169203331');
    expect(lines.find((l) => l.message === 'starting')).not.toHaveProperty('trace_id');
  }, 60000);

  it('collector that accepts connections and never answers (blackhole): serves, SIGTERM exits within 10 s', async () => {
    const sockets: net.Socket[] = [];
    const hole = net.createServer((s) => {
      sockets.push(s); // accept, never read, never write, never close
      s.on('error', () => undefined);
    });
    await new Promise<void>((r) => hole.listen(0, '127.0.0.1', r));
    const holePort = (hole.address() as net.AddressInfo).port;
    const port = await freePort();
    const p = start({
      PORT: String(port),
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${holePort}`,
      OTEL_METRIC_EXPORT_INTERVAL: '200',
    });
    try {
      await p.waitFor('"starting"');
      const c = client(port);
      await new Promise<void>((resolve, reject) =>
        c.charge(chargeReq(), (e: Error | null) => (e ? reject(e) : resolve())),
      );
      c.close();
      await new Promise((r) => setTimeout(r, 1000)); // let the exporters try
      const started = performance.now(); // monotonic: the host wall clock jumps
      p.child.kill('SIGTERM');
      expect(await p.exited).toBe(0);
      expect(performance.now() - started).toBeLessThan(10000);
    } finally {
      sockets.forEach((s) => s.destroy());
      hole.close();
    }
  }, 60000);

  it('an unusable setting is one JSON line and exit 1, no stack on stdout', async () => {
    const taken = net.createServer();
    await new Promise<void>((r) => taken.listen(0, '::', r));
    const port = (taken.address() as net.AddressInfo).port;
    try {
      const p = start({ PORT: String(port) });
      expect(await p.exited).toBe(1);
      const last = p.lines().pop();
      expect(last).toMatchObject({ severity: 'error' });
      expect(typeof last.error).toBe('string');
      expect(JSON.stringify(last)).not.toContain('    at ');
    } finally {
      taken.close();
    }
  }, 60000);
});
