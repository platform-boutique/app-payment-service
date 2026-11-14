import * as grpc from '@grpc/grpc-js';
import {
  charge,
  maskCard,
  type ChargeDeps,
  type ChargeRequest,
  type ChargeResponse,
} from './charge';
import { refund, type RefundRequest, type RefundResponse } from './refund';
import { PaymentError, toGrpcError } from './errors';
import type { Logger } from './logger';

/** Starts an RPC measurement; the returned function records the final status code. */
export type StartRpcMetrics = (method: string) => (code: number) => void;

export interface HandlerDeps {
  logger: Logger;
  startRpcMetrics: StartRpcMetrics;
  chargeDeps?: ChargeDeps;
}

/**
 * gRPC handlers for PaymentService. Logging rule: never log the request
 * object, the card number or the CVV; card data is logged only as brand and
 * last four digits (maskCard).
 */
export function makeHandlers({ logger, startRpcMetrics, chargeDeps }: HandlerDeps) {
  function chargeHandler(
    call: grpc.ServerUnaryCall<ChargeRequest, ChargeResponse>,
    callback: grpc.sendUnaryData<ChargeResponse>,
  ): void {
    const endMetrics = startRpcMetrics('Charge');
    const req = call.request;
    const card = maskCard(req.credit_card?.credit_card_number);
    const amount = req.amount
      ? { currency: req.amount.currency_code, units: req.amount.units, nanos: req.amount.nanos }
      : undefined;
    logger.info({ card, amount }, 'PaymentService#Charge invoked');

    charge(req, { logger, ...chargeDeps }).then(
      (response) => {
        endMetrics(grpc.status.OK);
        callback(null, response);
      },
      (err: unknown) => {
        const { code, message } = toGrpcError(err);
        if (err instanceof PaymentError) {
          logger.warn(
            { card, reason: err.reason, grpc_code: code, error: err.reason },
            'Charge failed',
          );
        } else {
          const errorName = err instanceof Error ? err.name : typeof err;
          logger.error(
            {
              card,
              grpc_code: code,
              error_name: errorName,
              error: errorName,
            },
            'Charge failed unexpectedly',
          );
        }
        endMetrics(code);
        callback({ code, message });
      },
    );
  }

  function refundHandler(
    call: grpc.ServerUnaryCall<RefundRequest, RefundResponse>,
    callback: grpc.sendUnaryData<RefundResponse>,
  ): void {
    const endMetrics = startRpcMetrics('Refund');
    const { transaction_id: transactionId } = call.request;
    try {
      const response = refund(call.request);
      logger.info(
        { transaction_id: transactionId, refund_id: response.refund_id },
        'Refund processed',
      );
      endMetrics(grpc.status.OK);
      callback(null, response);
    } catch (err: unknown) {
      const { code, message } = toGrpcError(err);
      logger.warn(
        {
          transaction_id: transactionId,
          reason: err instanceof PaymentError ? err.reason : 'internal_error',
          grpc_code: code,
        },
        'Refund failed',
      );
      endMetrics(code);
      callback({ code, message });
    }
  }

  return { charge: chargeHandler, refund: refundHandler };
}
