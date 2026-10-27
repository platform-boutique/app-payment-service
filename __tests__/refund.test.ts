import { status } from '@grpc/grpc-js';
import { refund } from '../src/refund';
import { PaymentError } from '../src/errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const amount = { currency_code: 'USD', units: 10, nanos: 0 };

function failure(req: Parameters<typeof refund>[0]): PaymentError {
  try {
    refund(req);
  } catch (err) {
    expect(err).toBeInstanceOf(PaymentError);
    return err as PaymentError;
  }
  throw new Error('expected refund to fail');
}

describe('refund()', () => {
  it('returns a UUID v5 refund_id', () => {
    expect(refund({ transaction_id: 'tx-1', amount }).refund_id).toMatch(UUID);
  });

  it('is idempotent: same transaction id -> same refund id, whatever the amount', () => {
    const a = refund({ transaction_id: 'tx-1', amount });
    const b = refund({ transaction_id: 'tx-1', amount: { ...amount, units: 3 } });
    const c = refund({ transaction_id: 'tx-1', amount: null });
    expect(b.refund_id).toBe(a.refund_id);
    expect(c.refund_id).toBe(a.refund_id);
  });

  it('different transaction ids -> different refund ids', () => {
    expect(refund({ transaction_id: 'tx-1', amount }).refund_id).not.toBe(
      refund({ transaction_id: 'tx-2', amount }).refund_id,
    );
  });

  it('ignores surrounding whitespace in the transaction id', () => {
    expect(refund({ transaction_id: '  tx-1 ', amount }).refund_id).toBe(
      refund({ transaction_id: 'tx-1', amount }).refund_id,
    );
  });

  it.each([[''], ['   ']])('rejects transaction id %j with INVALID_ARGUMENT', (id) => {
    const err = failure({ transaction_id: id, amount });
    expect(err.grpcCode).toBe(status.INVALID_ARGUMENT);
    expect(err.message).toBe('invalid_request: transaction_id is required');
  });

  it('rejects a missing transaction id', () => {
    const err = failure({ amount } as unknown as Parameters<typeof refund>[0]);
    expect(err.grpcCode).toBe(status.INVALID_ARGUMENT);
  });

  it('rejects a negative amount (units as the String proto-loader yields)', () => {
    const err = failure({ transaction_id: 'tx-1', amount: { ...amount, units: '-5' } });
    expect(err.grpcCode).toBe(status.INVALID_ARGUMENT);
    expect(err.message).toMatch(/negative/);
  });
});
