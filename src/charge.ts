import { v4 as uuidv4 } from 'uuid';
import cardValidator from 'simple-card-validator';
import { createLogger, type Logger } from './logger';
import { assertValidMoney, type Money } from './money';
import {
  CardDeclined,
  ExpiredCreditCard,
  InsufficientFunds,
  InvalidCreditCard,
  InvalidRequest,
  ProcessingError,
  UnacceptedCreditCard,
} from './errors';

// Re-exported so existing imports from './charge' keep working.
export {
  CardDeclined,
  ExpiredCreditCard,
  InsufficientFunds,
  InvalidCreditCard,
  ProcessingError,
  UnacceptedCreditCard,
} from './errors';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { Money };

export interface CreditCardInfo {
  credit_card_number: string;
  credit_card_cvv: number;
  credit_card_expiration_year: number;
  credit_card_expiration_month: number;
}

export interface ChargeRequest {
  amount: Money | null;
  credit_card: CreditCardInfo | null;
}

export interface ChargeResponse {
  transaction_id: string;
}

export interface ChargeDeps {
  logger?: Logger;
  /** Waits before the simulated processing error; injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Documented test cards (Stripe-style numbers; all Luhn-valid Visa)
// ---------------------------------------------------------------------------

export const TEST_CARDS = {
  DECLINED: '4000000000000002',
  INSUFFICIENT_FUNDS: '4000000000009995',
  PROCESSING_ERROR: '4000000000000119',
} as const;

/** How long the processing-error test card "hangs" before failing. */
export const PROCESSING_ERROR_DELAY_MS = 3000;

const defaultLogger = createLogger('payment-service-charge');
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Card data masking: the only card data that may be logged or returned
// ---------------------------------------------------------------------------

/**
 * simple-card-validator throws a bare string for an empty number; treat any
 * throw as "unknown, invalid" so it maps to invalid_card instead of INTERNAL.
 */
function cardDetails(cardNumber: string): { card_type: string; valid: boolean } {
  try {
    return cardValidator(cardNumber).getCardDetails();
  } catch {
    return { card_type: 'unknown', valid: false };
  }
}

export function digitsOnly(cardNumber: string): string {
  return cardNumber.replace(/\D/g, '');
}

export function lastFour(cardNumber: string): string {
  return digitsOnly(cardNumber).slice(-4);
}

/** Safe description of a card for logs: brand and last four digits only. */
export function maskCard(cardNumber: string | undefined | null): {
  brand: string;
  last4: string;
} {
  const number = cardNumber ?? '';
  const { card_type: brand } = cardDetails(number);
  return { brand: brand || 'unknown', last4: lastFour(number) };
}

// ---------------------------------------------------------------------------
// Charge logic
// ---------------------------------------------------------------------------

/**
 * Verifies the credit card and (pretend) charges it. Resolves with a random
 * transaction id, or rejects with a PaymentError (see errors.ts).
 */
export async function charge(
  request: ChargeRequest,
  deps: ChargeDeps = {},
): Promise<ChargeResponse> {
  const logger = deps.logger ?? defaultLogger;
  const sleep = deps.sleep ?? defaultSleep;
  const { amount, credit_card: creditCard } = request;

  if (!creditCard || typeof creditCard.credit_card_number !== 'string') {
    throw new InvalidCreditCard();
  }
  const cardNumber = creditCard.credit_card_number;
  const { card_type: cardType, valid } = cardDetails(cardNumber);

  if (!valid) {
    throw new InvalidCreditCard();
  }

  // Only VISA and MasterCard accepted
  if (!(cardType === 'visa' || cardType === 'mastercard')) {
    throw new UnacceptedCreditCard(cardType);
  }

  // CVV: an int32 on the wire, so leading zeros are already lost ("012" arrives as 12): the
  // check is an integer 0-9999, i.e. at most 4 digits. The value is never logged or echoed.
  const cvv = creditCard.credit_card_cvv;
  if (!Number.isInteger(cvv) || cvv < 0 || cvv > 9999) {
    throw new InvalidCreditCard('CVV must be 3 or 4 digits');
  }

  const last4 = lastFour(cardNumber);

  // Validate expiration is >= this month
  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();
  const { credit_card_expiration_year: year, credit_card_expiration_month: month } = creditCard;

  // A month outside 1-12 (e.g. 99) would otherwise compare as "far in the future" and pass the expiry check.
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new InvalidCreditCard();
  }

  if (currentYear * 12 + currentMonth > year * 12 + month) {
    throw new ExpiredCreditCard(last4, month, year);
  }

  // The amount must be present and valid; a charge without an amount is not a charge.
  if (!amount) {
    throw new InvalidRequest('amount is required');
  }
  assertValidMoney(amount, 'amount');

  // Simulated issuer / processor outcomes for the documented test cards.
  switch (digitsOnly(cardNumber)) {
    case TEST_CARDS.DECLINED:
      throw new CardDeclined(last4);
    case TEST_CARDS.INSUFFICIENT_FUNDS:
      throw new InsufficientFunds(last4);
    case TEST_CARDS.PROCESSING_ERROR:
      await sleep(PROCESSING_ERROR_DELAY_MS);
      throw new ProcessingError();
  }

  const transactionId = uuidv4();
  logger.info(
    {
      brand: cardType,
      last4,
      currency: amount?.currency_code,
      units: amount?.units,
      nanos: amount?.nanos,
      transaction_id: transactionId,
    },
    'Transaction processed',
  );

  return { transaction_id: transactionId };
}
