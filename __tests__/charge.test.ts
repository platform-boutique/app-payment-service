import { status } from '@grpc/grpc-js';
import { charge, maskCard, PROCESSING_ERROR_DELAY_MS, TEST_CARDS } from '../src/charge';
import { PaymentError, toGrpcError } from '../src/errors';
import { createLogger } from '../src/logger';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_VISA = '4111111111111111';
const VALID_MASTERCARD = '5555555555554444';
const VALID_MASTERCARD_2 = '5500005555555559';
const VALID_AMEX = '371449635398431';
const INVALID_CARD = '1234567890123456';

const futureYear = new Date().getFullYear() + 1;
const currentYear = new Date().getFullYear();
const currentMonth = new Date().getMonth() + 1;

// A month guaranteed to be in the past
const pastYear = currentYear - 1;
const pastMonth = 1;

// Silent logger and an instant sleep that records what it was asked to wait.
const silent = createLogger('test', { write: () => undefined });
const sleeps: number[] = [];
const deps = {
  logger: silent,
  sleep: async (ms: number) => {
    sleeps.push(ms);
  },
};

function makeRequest(overrides: {
  cardNumber?: string;
  expirationYear?: number;
  expirationMonth?: number;
  currencyCode?: string;
  units?: number;
  nanos?: number;
}) {
  return {
    amount: {
      currency_code: overrides.currencyCode ?? 'USD',
      units: overrides.units ?? 100,
      nanos: overrides.nanos ?? 0,
    },
    credit_card: {
      credit_card_number: overrides.cardNumber ?? VALID_VISA,
      credit_card_cvv: 123,
      credit_card_expiration_year: overrides.expirationYear ?? futureYear,
      credit_card_expiration_month: overrides.expirationMonth ?? 1,
    },
  };
}

async function failure(req: Parameters<typeof charge>[0]): Promise<PaymentError> {
  try {
    await charge(req, deps);
  } catch (err) {
    expect(err).toBeInstanceOf(PaymentError);
    return err as PaymentError;
  }
  throw new Error('expected charge to fail');
}

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe('charge() — happy paths', () => {
  it.each([
    ['Visa', VALID_VISA],
    ['MasterCard', VALID_MASTERCARD],
    ['MasterCard (2)', VALID_MASTERCARD_2],
    ['Visa with spaces', '4111 1111 1111 1111'],
  ])('accepts %s and returns a transaction_id', async (_name, cardNumber) => {
    const result = await charge(makeRequest({ cardNumber }), deps);
    expect(typeof result.transaction_id).toBe('string');
    expect(result.transaction_id.length).toBeGreaterThan(0);
  });

  it('generates a unique transaction_id on each call', async () => {
    const r1 = await charge(makeRequest({}), deps);
    const r2 = await charge(makeRequest({}), deps);
    expect(r1.transaction_id).not.toBe(r2.transaction_id);
  });

  it('accepts a card expiring exactly this month', async () => {
    const result = await charge(
      makeRequest({ expirationYear: currentYear, expirationMonth: currentMonth }),
      deps,
    );
    expect(result).toHaveProperty('transaction_id');
  });

  it('works with any currency code', async () => {
    await expect(charge(makeRequest({ currencyCode: 'EUR' }), deps)).resolves.toHaveProperty(
      'transaction_id',
    );
  });

  it('works with zero-unit amounts (nanos only)', async () => {
    await expect(
      charge(makeRequest({ units: 0, nanos: 500_000_000 }), deps),
    ).resolves.toHaveProperty('transaction_id');
  });
});

describe('charge() — amount validation -> INVALID_ARGUMENT', () => {
  it('rejects a missing amount', async () => {
    const req = { ...makeRequest({}), amount: null };
    const err = await failure(req);
    expect(err.grpcCode).toBe(status.INVALID_ARGUMENT);
    expect(err.reason).toBe('invalid_request');
  });

  it.each([
    ['negative units', { units: -50 }],
    ['negative nanos', { nanos: -1 }],
    ['nanos above 999999999', { nanos: 1_000_000_000 }],
  ])('rejects %s', async (_name, overrides) => {
    const err = await failure(makeRequest(overrides));
    expect(err.grpcCode).toBe(status.INVALID_ARGUMENT);
    expect(err.reason).toBe('invalid_request');
  });
});

// ---------------------------------------------------------------------------
// Validation failures -> INVALID_ARGUMENT
// ---------------------------------------------------------------------------

describe('charge() — invalid card -> INVALID_ARGUMENT', () => {
  it.each([
    ['a Luhn-failing number', INVALID_CARD],
    ['an empty string', ''],
    ['all zeros', '0000000000000000'],
  ])('rejects %s as invalid_card', async (_name, cardNumber) => {
    const err = await failure(makeRequest({ cardNumber }));
    expect(err.grpcCode).toBe(status.INVALID_ARGUMENT);
    expect(err.reason).toBe('invalid_card');
    expect(err.message).toBe('invalid_card: Credit card info is invalid');
  });

  it('rejects a missing credit_card as invalid_card', async () => {
    const err = await failure({ amount: null, credit_card: null });
    expect(err.grpcCode).toBe(status.INVALID_ARGUMENT);
    expect(err.reason).toBe('invalid_card');
  });

  it('rejects AMEX as card_not_accepted, naming the brand and the accepted ones', async () => {
    const err = await failure(makeRequest({ cardNumber: VALID_AMEX }));
    expect(err.grpcCode).toBe(status.INVALID_ARGUMENT);
    expect(err.message).toMatch(/^card_not_accepted: Sorry, we cannot process/);
    expect(err.message).toMatch(/american.express|amex/i);
    expect(err.message).toMatch(/VISA|MasterCard/i);
  });
});

describe('charge() — expired card -> INVALID_ARGUMENT', () => {
  it('rejects a card expired last year', async () => {
    const err = await failure(
      makeRequest({ expirationYear: pastYear, expirationMonth: pastMonth }),
    );
    expect(err.grpcCode).toBe(status.INVALID_ARGUMENT);
    expect(err.reason).toBe('expired_card');
    expect(err.message).toMatch(/^expired_card: .*expired/);
  });

  it('rejects a card that expired last month', async () => {
    const lastMonth = currentMonth === 1 ? 12 : currentMonth - 1;
    const yearOfLastMonth = currentMonth === 1 ? currentYear - 1 : currentYear;
    const err = await failure(
      makeRequest({ expirationYear: yearOfLastMonth, expirationMonth: lastMonth }),
    );
    expect(err.reason).toBe('expired_card');
  });

  it.each([[0], [13], [99], [-1], [1.5]])(
    'rejects expiration month %s as invalid_card (not accepted as "far in the future")',
    async (expirationMonth) => {
      const err = await failure(makeRequest({ expirationYear: futureYear, expirationMonth }));
      expect(err.grpcCode).toBe(status.INVALID_ARGUMENT);
      expect(err.reason).toBe('invalid_card');
    },
  );

  it('message has the last four digits and the expiry, never the full number', async () => {
    const err = await failure(makeRequest({ expirationYear: pastYear, expirationMonth: 6 }));
    expect(err.message).toContain('ending 1111');
    expect(err.message).toContain(`6/${pastYear}`);
    expect(err.message).not.toContain(VALID_VISA);
  });

  it('expiry is checked before the test-card outcomes', async () => {
    const err = await failure(
      makeRequest({ cardNumber: TEST_CARDS.DECLINED, expirationYear: pastYear }),
    );
    expect(err.reason).toBe('expired_card');
  });
});

// ---------------------------------------------------------------------------
// Test cards
// ---------------------------------------------------------------------------

describe('charge() — test cards', () => {
  it('4000000000000002 is declined -> FAILED_PRECONDITION card_declined', async () => {
    const err = await failure(makeRequest({ cardNumber: TEST_CARDS.DECLINED }));
    expect(err.grpcCode).toBe(status.FAILED_PRECONDITION);
    expect(err.message).toMatch(/^card_declined: /);
    expect(err.message).toContain('ending 0002');
  });

  it('4000000000009995 -> FAILED_PRECONDITION insufficient_funds', async () => {
    const err = await failure(makeRequest({ cardNumber: TEST_CARDS.INSUFFICIENT_FUNDS }));
    expect(err.grpcCode).toBe(status.FAILED_PRECONDITION);
    expect(err.message).toMatch(/^insufficient_funds: /);
    expect(err.message).toContain('ending 9995');
  });

  it('4000000000000119 waits ~3 s, then fails as retriable UNAVAILABLE processing_error', async () => {
    sleeps.length = 0;
    const err = await failure(makeRequest({ cardNumber: TEST_CARDS.PROCESSING_ERROR }));
    expect(sleeps).toEqual([PROCESSING_ERROR_DELAY_MS]);
    expect(PROCESSING_ERROR_DELAY_MS).toBe(3000);
    expect(err.grpcCode).toBe(status.UNAVAILABLE);
    expect(err.message).toMatch(/^processing_error: .*retry/);
  });

  it('the processing error really waits when no sleep is injected', async () => {
    jest.useFakeTimers();
    try {
      let settled = false;
      const p = charge(makeRequest({ cardNumber: TEST_CARDS.PROCESSING_ERROR }), {
        logger: silent,
      }).catch((e) => {
        settled = true;
        return e;
      });
      await jest.advanceTimersByTimeAsync(PROCESSING_ERROR_DELAY_MS - 1);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      const err = await p;
      expect(settled).toBe(true);
      expect(err.reason).toBe('processing_error');
    } finally {
      jest.useRealTimers();
    }
  });

  it('test cards with separators behave the same', async () => {
    const err = await failure(makeRequest({ cardNumber: '4000 0000 0000 0002' }));
    expect(err.reason).toBe('card_declined');
  });
});

// ---------------------------------------------------------------------------
// Error mapping and masking
// ---------------------------------------------------------------------------

describe('toGrpcError()', () => {
  it('keeps code and message of a PaymentError', async () => {
    const err = await failure(makeRequest({ cardNumber: TEST_CARDS.INSUFFICIENT_FUNDS }));
    expect(toGrpcError(err)).toEqual({ code: status.FAILED_PRECONDITION, message: err.message });
  });

  it('maps anything unexpected to INTERNAL with a generic message', () => {
    const mapped = toGrpcError(new TypeError('secret 4111111111111111'));
    expect(mapped.code).toBe(status.INTERNAL);
    expect(mapped.message).toBe('internal_error: unexpected payment failure');
    expect(toGrpcError('a string').code).toBe(status.INTERNAL);
  });
});

describe('maskCard()', () => {
  it('returns brand and last four only', () => {
    expect(maskCard(VALID_VISA)).toEqual({ brand: 'visa', last4: '1111' });
    expect(maskCard(VALID_MASTERCARD)).toEqual({ brand: 'mastercard', last4: '4444' });
    expect(maskCard(undefined)).toEqual({ brand: 'unknown', last4: '' });
  });
});
