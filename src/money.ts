import { InvalidRequest } from './errors';

export interface Money {
  currency_code: string;
  units: number | string; // proto-loader is configured with longs: String
  nanos: number;
}

const NANOS_MAX = 999_999_999;

/**
 * Validates a Money value as it arrives over gRPC (units is a decimal string
 * from proto-loader, a number in unit tests): units must be an integer that is
 * not negative, nanos an integer in 0-999999999. A missing nanos counts as 0.
 * Throws InvalidRequest naming the field; never echoes the value.
 */
export function assertValidMoney(amount: Money, what: string): void {
  const units = amount.units ?? 0;
  const unitsOk =
    typeof units === 'number' ? Number.isSafeInteger(units) : /^-?\d{1,19}$/.test(units);
  if (!unitsOk) {
    throw new InvalidRequest(`${what}.units must be an integer`);
  }
  if (Number(units) < 0) {
    throw new InvalidRequest(`${what} must not be negative`);
  }
  const nanos = amount.nanos ?? 0;
  if (!Number.isInteger(nanos) || nanos < 0 || nanos > NANOS_MAX) {
    throw new InvalidRequest(`${what}.nanos must be an integer between 0 and ${NANOS_MAX}`);
  }
}
