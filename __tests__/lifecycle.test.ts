/**
 * Graceful shutdown over a real in-process gRPC server: an in-flight Charge
 * must finish before the process exits, health must say NOT_SERVING, and a
 * call that never finishes is cut after the drain timeout.
 */
import path from 'path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { makeHandlers } from '../src/handlers';
import { createLogger } from '../src/logger';
import { TEST_CARDS } from '../src/charge';
import {
  createHealth,
  createShutdown,
  drainTimeoutFromEnv,
  DEFAULT_DRAIN_TIMEOUT_MS,
} from '../src/lifecycle';

const silent = createLogger('test', { write: () => undefined });
const futureYear = new Date().getFullYear() + 2;

function loadProto(file: string) {
  const def = protoLoader.loadSync(path.join(__dirname, '../proto', file), {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return grpc.loadPackageDefinition(def) as any;
}

/** A processing-error charge: it "hangs" in sleep() until release() is called. */
function slowChargeReq() {
  return {
    amount: { currency_code: 'USD', units: 1, nanos: 0 },
    credit_card: {
      credit_card_number: TEST_CARDS.PROCESSING_ERROR,
      credit_card_cvv: 123,
      credit_card_expiration_year: futureYear,
      credit_card_expiration_month: 12,
    },
  };
}

async function start() {
  let release: () => void = () => undefined;
  let started: () => void = () => undefined;
  const inFlight = new Promise<void>((r) => (started = r));
  const gate = new Promise<void>((r) => (release = r));
  const health = createHealth();
  const server = new grpc.Server();
  server.addService(
    loadProto('payment.proto').hipstershop.PaymentService.service,
    makeHandlers({
      logger: silent,
      startRpcMetrics: () => () => undefined,
      chargeDeps: {
        sleep: async () => {
          started();
          await gate;
        },
      },
    }),
  );
  server.addService(loadProto('health.proto').grpc.health.v1.Health.service, {
    check: health.check,
  });
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) =>
      e ? reject(e) : resolve(p),
    ),
  );
  const client = new (loadProto('payment.proto').hipstershop.PaymentService)(
    `127.0.0.1:${port}`,
    grpc.credentials.createInsecure(),
  );
  return { server, health, client, release, inFlight };
}

describe('graceful shutdown', () => {
  it('waits for an in-flight Charge, reports NOT_SERVING, then flushes and exits 0', async () => {
    const { server, health, client, release, inFlight } = await start();
    const events: string[] = [];
    const exit = jest.fn((code: number) => events.push(`exit:${code}`));
    const shutdown = createShutdown({
      server,
      health,
      flushTelemetry: async () => void events.push('flush'),
      exit,
      logger: silent,
      drainTimeoutMs: 5000,
    });

    const result = new Promise<grpc.ServiceError | null>((resolve) =>
      client.charge(slowChargeReq(), (err: grpc.ServiceError | null) => {
        events.push('charge-finished');
        resolve(err);
      }),
    );
    await inFlight; // the handler is running

    const done = shutdown();
    // Health says NOT_SERVING as soon as shutdown starts.
    const answers: string[] = [];
    health.check({} as never, (_e, r) => answers.push(r!.status));
    expect(answers).toEqual(['NOT_SERVING']);

    // Not exited while the charge is still running.
    await new Promise((r) => setTimeout(r, 150));
    expect(exit).not.toHaveBeenCalled();

    release();
    const err = await result;
    await done;

    // The call was answered by the handler (the simulated processing error), not cut off.
    expect(err?.code).toBe(grpc.status.UNAVAILABLE);
    expect(err?.details).toMatch(/^processing_error: /);
    expect(events).toEqual(['charge-finished', 'flush', 'exit:0']);
    client.close();
  });

  it('cuts a call that does not finish after the drain timeout, then still exits 0', async () => {
    const { server, health, client, inFlight } = await start();
    const exit = jest.fn();
    const forceSpy = jest.spyOn(server, 'forceShutdown');
    const shutdown = createShutdown({
      server,
      health,
      flushTelemetry: async () => undefined,
      exit,
      logger: silent,
      drainTimeoutMs: 200,
    });
    const result = new Promise<grpc.ServiceError | null>((resolve) =>
      client.charge(slowChargeReq(), (err: grpc.ServiceError | null) => resolve(err)),
    );
    await inFlight;
    const started = Date.now();
    await shutdown();
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
    expect(forceSpy).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect((await result)?.details ?? '').not.toMatch(/^processing_error/);
    client.close();
  });

  it('with nothing in flight it exits right away without forcing', async () => {
    const { server, health, client } = await start();
    const exit = jest.fn();
    const forceSpy = jest.spyOn(server, 'forceShutdown');
    await createShutdown({
      server,
      health,
      flushTelemetry: async () => undefined,
      exit,
      logger: silent,
      drainTimeoutMs: 5000,
    })();
    expect(forceSpy).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
    client.close();
  });

  it('is idempotent: a second signal does not shut down twice', async () => {
    const server = {
      tryShutdown: jest.fn((cb: (e?: Error) => void) => cb()),
      forceShutdown: jest.fn(),
    };
    const exit = jest.fn();
    const shutdown = createShutdown({
      server,
      health: createHealth(),
      flushTelemetry: async () => undefined,
      exit,
      logger: silent,
      drainTimeoutMs: 1000,
    });
    await Promise.all([shutdown(), shutdown()]);
    await shutdown();
    expect(server.tryShutdown).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

describe('health', () => {
  it('is SERVING until setServing(false)', () => {
    const health = createHealth();
    const statuses: string[] = [];
    health.check({} as never, (_e, r) => statuses.push(r!.status));
    health.setServing(false);
    health.check({} as never, (_e, r) => statuses.push(r!.status));
    expect(statuses).toEqual(['SERVING', 'NOT_SERVING']);
  });
});

describe('drainTimeoutFromEnv', () => {
  it.each([
    [undefined, DEFAULT_DRAIN_TIMEOUT_MS],
    ['', DEFAULT_DRAIN_TIMEOUT_MS],
    ['abc', DEFAULT_DRAIN_TIMEOUT_MS],
    ['0', DEFAULT_DRAIN_TIMEOUT_MS],
    ['-5', DEFAULT_DRAIN_TIMEOUT_MS],
    ['1.5', DEFAULT_DRAIN_TIMEOUT_MS],
    ['8000', 8000],
  ])('%j -> %i', (raw, want) => {
    const env = raw === undefined ? {} : { SHUTDOWN_DRAIN_TIMEOUT_MS: raw };
    expect(drainTimeoutFromEnv(env as NodeJS.ProcessEnv)).toBe(want);
  });
});
