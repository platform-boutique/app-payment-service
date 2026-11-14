import { v5 as uuidv5 } from 'uuid';
import { InvalidRequest } from './errors';
import { assertValidMoney, type Money } from './money';

export interface RefundRequest {
  transaction_id: string;
  amount: Money | null;
}

export interface RefundResponse {
  refund_id: string;
}

/** Fixed namespace so the same transaction id always yields the same refund id. */
const REFUND_NAMESPACE = '6f1d3c0e-5b7a-4c1e-9a52-2f0b8d7e4a10';

/**
 * Simulated refund. Nothing is stored and the transaction is not looked up
 * (the service keeps no state): any non-empty transaction id is accepted.
 * The refund id is a UUID v5 of the transaction id, so retries are
 * idempotent: the same transaction id always gets the same refund id,
 * whatever the amount.
 */
export function refund(request: RefundRequest): RefundResponse {
  const transactionId = (request.transaction_id ?? '').trim();
  if (transactionId === '') {
    throw new InvalidRequest('transaction_id is required');
  }
  const amount = request.amount;
  if (amount) {
    assertValidMoney(amount, 'amount');
  }
  return { refund_id: uuidv5(transactionId, REFUND_NAMESPACE) };
}
