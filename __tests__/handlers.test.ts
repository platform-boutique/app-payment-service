/**
 * End-to-end over a real in-process gRPC server (loopback, random port):
 * proto wiring, status-code mapping, metrics codes, and that no card data
 * reaches the logs.
 */
import path from 'path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { makeHandlers } from '../src/handlers';
import { createLogger } from '../src/logger';
import { TEST_CARDS } from '../src/charge';

const CVV = 987; // distinctive, so a leak is unambiguous in the logs
const futureYear = new Date().getFullYear() + 2;

const lines: string[] = [];
const logger = createLogger('test', {
  write: (s: string) => {
    lines.push(s);
  },
});
const metricCodes: Array<[string, number]> = [];
const startRpcMetrics = (method: string) => (code: number) => {
  metricCodes.push([method, code]);
};

let server: grpc.Server;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;

beforeAll(async () => {
  const def = protoLoader.loadSync(path.join(__dirname, '../proto/payment.proto'), {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proto = (grpc.loadPackageDefinition(def) as any).hipstershop;
  server = new grpc.Server();
  server.addService(
    proto.PaymentService.service,
    makeHandlers({ logger, startRpcMetrics, chargeDeps: { sleep: async () => undefined } }),
  );
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, p) =>
      err ? reject(err) : resolve(p),
    ),
  );
  client = new proto.PaymentService(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
});

afterAll(() => {
  client?.close();
  server?.forceShutdown();
});

beforeEach(() => {
  lines.length = 0;
  metricCodes.length = 0;
});

function call<T>(method: 'Charge' | 'Refund', req: unknown): Promise<T> {
  return new Promise((resolve, reject) =>
    client[method](req, (err: grpc.ServiceError | null, res: T) =>
      err ? reject(err) : resolve(res),
    ),
  );
}

function chargeReq(cardNumber: string) {
  return {
    amount: { currency_code: 'USD', units: 42, nanos: 0 },
    credit_card: {
      credit_card_number: cardNumber,
      credit_card_cvv: CVV,
      credit_card_expiration_year: futureYear,
      credit_card_expiration_month: 12,
    },
  };
}

function expectNoCardDataInLogs(cardNumber: string) {
  expect(lines.length).toBeGreaterThan(0);
  const all = lines.join('\n');
  expect(all).not.toContain(cardNumber);
  expect(all).not.toContain(cardNumber.slice(0, 6)); // not even the BIN
  expect(all).not.toContain(String(CVV));
  expect(all).not.toMatch(/credit_card_number|credit_card_cvv|"cvv"/);
  for (const line of lines) {
    const rec = JSON.parse(line);
    if (rec.card) {
      expect(Object.keys(rec.card).sort()).toEqual(['brand', 'last4']);
      expect(rec.card.last4).toBe(cardNumber.slice(-4));
    }
  }
}

describe('Charge over gRPC', () => {
  it.each(['4111111111111111', '5555555555554444'])('%s succeeds', async (card) => {
    const res = await call<{ transaction_id: string }>('Charge', chargeReq(card));
    expect(res.transaction_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(metricCodes).toEqual([['Charge', grpc.status.OK]]);
    expectNoCardDataInLogs(card);
  });

  it.each([
    ['1234567890123456', grpc.status.INVALID_ARGUMENT, 'invalid_card: '],
    ['371449635398431', grpc.status.INVALID_ARGUMENT, 'card_not_accepted: '],
    [TEST_CARDS.DECLINED, grpc.status.FAILED_PRECONDITION, 'card_declined: '],
    [TEST_CARDS.INSUFFICIENT_FUNDS, grpc.status.FAILED_PRECONDITION, 'insufficient_funds: '],
    [TEST_CARDS.PROCESSING_ERROR, grpc.status.UNAVAILABLE, 'processing_error: '],
  ])('%s -> code %i with prefix %s, no card data in logs', async (card, code, prefix) => {
    await expect(call('Charge', chargeReq(card))).rejects.toMatchObject({ code });
    try {
      await call('Charge', chargeReq(card));
    } catch (err) {
      expect((err as grpc.ServiceError).details.startsWith(prefix)).toBe(true);
      expect((err as grpc.ServiceError).details).not.toContain(card);
    }
    expect(metricCodes[0]).toEqual(['Charge', code]);
    expectNoCardDataInLogs(card);
  });

  it('expired card -> INVALID_ARGUMENT expired_card, no card data in logs', async () => {
    const req = chargeReq('4111111111111111');
    req.credit_card.credit_card_expiration_year = 2000;
    await expect(call('Charge', req)).rejects.toMatchObject({
      code: grpc.status.INVALID_ARGUMENT,
      details: expect.stringMatching(/^expired_card: /),
    });
    expectNoCardDataInLogs('4111111111111111');
  });

  it('missing card -> INVALID_ARGUMENT', async () => {
    await expect(
      call('Charge', { amount: { currency_code: 'USD', units: 1 } }),
    ).rejects.toMatchObject({
      code: grpc.status.INVALID_ARGUMENT,
      details: expect.stringMatching(/^invalid_card: /),
    });
  });
});

describe('Charge — unexpected failure', () => {
  it('maps a non-PaymentError to INTERNAL with a generic message and logs no card data', async () => {
    const card = '4111111111111111';
    const failing = makeHandlers({
      logger,
      startRpcMetrics,
      chargeDeps: {
        logger: {
          info: () => {
            throw new Error(`boom ${card}`);
          },
        } as unknown as typeof logger,
      },
    });
    const result = await new Promise<grpc.ServiceError>((resolve) =>
      failing.charge(
        { request: chargeReq(card) } as unknown as grpc.ServerUnaryCall<never, never>,
        (err) => resolve(err as grpc.ServiceError),
      ),
    );
    expect(result.code).toBe(grpc.status.INTERNAL);
    expect(result.message).toBe('internal_error: unexpected payment failure');
    expect(metricCodes).toEqual([['Charge', grpc.status.INTERNAL]]);
    expectNoCardDataInLogs(card);
  });
});

describe('Refund over gRPC', () => {
  it('returns the same refund_id for the same transaction id', async () => {
    const req = { transaction_id: 'tx-abc', amount: { currency_code: 'USD', units: 5, nanos: 0 } };
    const a = await call<{ refund_id: string }>('Refund', req);
    const b = await call<{ refund_id: string }>('Refund', req);
    expect(a.refund_id).toBeTruthy();
    expect(b.refund_id).toBe(a.refund_id);
    expect(metricCodes).toEqual([
      ['Refund', grpc.status.OK],
      ['Refund', grpc.status.OK],
    ]);
  });

  it('empty transaction id -> INVALID_ARGUMENT', async () => {
    await expect(call('Refund', { transaction_id: '' })).rejects.toMatchObject({
      code: grpc.status.INVALID_ARGUMENT,
      details: 'invalid_request: transaction_id is required',
    });
  });
});

describe('logger redaction (defence in depth)', () => {
  it('censors card fields even if a whole request is logged by mistake', () => {
    lines.length = 0;
    logger.info({ request: chargeReq('4111111111111111') }, 'oops');
    expect(lines.join('')).not.toContain('4111111111111111');
    expect(lines.join('')).not.toContain(String(CVV));
    expect(lines.join('')).toContain('[REDACTED]');
  });
});
