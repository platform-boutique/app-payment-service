import type * as grpc from '@grpc/grpc-js';
import type { Logger } from './logger';

/** The standard gRPC health service state: SERVING until shutdown starts. */
export interface Health {
  check: (
    call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<{ status: string }>,
  ) => void;
  setServing: (serving: boolean) => void;
  isServing: () => boolean;
}

export function createHealth(): Health {
  let serving = true;
  return {
    check: (_call, callback) => callback(null, { status: serving ? 'SERVING' : 'NOT_SERVING' }),
    setServing: (value) => {
      serving = value;
    },
    isServing: () => serving,
  };
}

/** Default upper bound for waiting on in-flight RPCs (the 3 s processing-error card fits). */
export const DEFAULT_DRAIN_TIMEOUT_MS = 5000;

/** Reads SHUTDOWN_DRAIN_TIMEOUT_MS (a positive integer of milliseconds); anything else uses the default. */
export function drainTimeoutFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SHUTDOWN_DRAIN_TIMEOUT_MS;
  const parsed = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_DRAIN_TIMEOUT_MS;
}

export interface ShutdownOptions {
  server: Pick<grpc.Server, 'tryShutdown' | 'forceShutdown'>;
  health: Pick<Health, 'setServing'>;
  /** Bounded telemetry flush (telemetry.flushTelemetry). */
  flushTelemetry: () => Promise<void>;
  exit: (code: number) => void;
  logger: Pick<Logger, 'info' | 'warn'>;
  drainTimeoutMs: number;
}

/**
 * Returns the shutdown routine for SIGTERM/SIGINT. In order: health goes
 * NOT_SERVING, the server stops accepting calls and waits (tryShutdown) for
 * the in-flight ones, at most drainTimeoutMs, after which the remaining ones
 * are cut (forceShutdown); then telemetry is flushed and the process exits 0.
 * Calling it again returns the same promise.
 */
export function createShutdown(opts: ShutdownOptions): () => Promise<void> {
  let running: Promise<void> | null = null;
  return () => {
    running ??= run(opts);
    return running;
  };
}

async function run({
  server,
  health,
  flushTelemetry,
  exit,
  logger,
  drainTimeoutMs,
}: ShutdownOptions): Promise<void> {
  health.setServing(false);
  logger.info({ drain_timeout_ms: drainTimeoutMs }, 'Shutdown: draining in-flight calls');

  let timer: NodeJS.Timeout | undefined;
  const drained = new Promise<'drained'>((resolve) => {
    server.tryShutdown((err) => {
      if (err) logger.warn({ error: err }, 'Shutdown: tryShutdown reported an error');
      resolve('drained');
    });
  });
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), drainTimeoutMs);
  });
  const outcome = await Promise.race([drained, timedOut]);
  clearTimeout(timer);
  if (outcome === 'timeout') {
    logger.warn(
      { drain_timeout_ms: drainTimeoutMs },
      'Shutdown: drain timed out, forcing shutdown',
    );
    server.forceShutdown();
  } else {
    logger.info('Shutdown: all in-flight calls finished');
  }

  await flushTelemetry();
  exit(0);
}
