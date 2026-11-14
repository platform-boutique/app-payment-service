import { status } from '@grpc/grpc-js';

/**
 * Machine-readable failure reasons. They are the prefix of the gRPC status
 * message (`<reason>: <human text>`), so callers can branch on them without
 * parsing prose. The values are stable: do not rename them.
 */
export type PaymentReason =
  | 'invalid_card'
  | 'card_not_accepted'
  | 'expired_card'
  | 'card_declined'
  | 'insufficient_funds'
  | 'processing_error'
  | 'invalid_request'
  | 'internal_error';

/** A known payment failure with its gRPC status code and reason. */
export class PaymentError extends Error {
  readonly grpcCode: status;
  readonly reason: PaymentReason;
  constructor(grpcCode: status, reason: PaymentReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = 'PaymentError';
    this.grpcCode = grpcCode;
    this.reason = reason;
  }
}

export class InvalidCreditCard extends PaymentError {
  constructor(detail?: string) {
    super(
      status.INVALID_ARGUMENT,
      'invalid_card',
      detail ? `Credit card info is invalid: ${detail}` : 'Credit card info is invalid',
    );
  }
}

export class UnacceptedCreditCard extends PaymentError {
  constructor(cardType: string) {
    super(
      status.INVALID_ARGUMENT,
      'card_not_accepted',
      `Sorry, we cannot process ${cardType} credit cards. Only VISA or MasterCard is accepted.`,
    );
  }
}

export class ExpiredCreditCard extends PaymentError {
  constructor(lastFour: string, month: number, year: number) {
    super(
      status.INVALID_ARGUMENT,
      'expired_card',
      `Your credit card (ending ${lastFour}) expired on ${month}/${year}`,
    );
  }
}

export class CardDeclined extends PaymentError {
  constructor(lastFour: string) {
    super(
      status.FAILED_PRECONDITION,
      'card_declined',
      `Your card (ending ${lastFour}) was declined by the issuer`,
    );
  }
}

export class InsufficientFunds extends PaymentError {
  constructor(lastFour: string) {
    super(
      status.FAILED_PRECONDITION,
      'insufficient_funds',
      `Your card (ending ${lastFour}) has insufficient funds`,
    );
  }
}

/** Simulated processor outage: retriable. */
export class ProcessingError extends PaymentError {
  constructor() {
    super(
      status.UNAVAILABLE,
      'processing_error',
      'The payment processor could not complete the charge; please retry',
    );
  }
}

export class InvalidRequest extends PaymentError {
  constructor(detail: string) {
    super(status.INVALID_ARGUMENT, 'invalid_request', detail);
  }
}

/**
 * Maps any thrown value to a gRPC error. Known PaymentErrors keep their code
 * and message; anything else becomes INTERNAL with a generic message, so an
 * unexpected exception text never reaches the caller (or the span attributes).
 */
export function toGrpcError(err: unknown): { code: status; message: string } {
  if (err instanceof PaymentError) {
    return { code: err.grpcCode, message: err.message };
  }
  return { code: status.INTERNAL, message: 'internal_error: unexpected payment failure' };
}
