import type { Meter } from '@opentelemetry/api';
import type { PaymentReason } from './errors';

/** What the build_info gauge reports (CODE-06): all three come from the environment, see telemetry-config.ts. */
export interface BuildInfo {
  serviceName: string;
  serviceVersion: string;
  serviceCommit: string;
}

/** build_info{service,version,commit} = 1, so a dashboard can show which build runs where. */
export function registerBuildInfo(meter: Meter, info: BuildInfo): void {
  const attributes = {
    service: info.serviceName,
    version: info.serviceVersion,
    commit: info.serviceCommit,
  };
  meter
    .createObservableGauge('build_info', {
      description: 'Build information of the running service, always 1',
    })
    .addCallback((obs) => obs.observe(1, attributes));
}

/** Outcome label of the payments counter: "success" or the PaymentReason of the failure (bounded set). */
export type PaymentOutcome = 'success' | PaymentReason;

/**
 * payment_charges_total{outcome}: one increment per finished Charge call. The label is
 * "success" or one of the PaymentReason values, never card data, ids or free text (OBS-20).
 */
export function createPaymentOutcomeCounter(meter: Meter): (outcome: PaymentOutcome) => void {
  const counter = meter.createCounter('payment_charges_total', {
    description: 'Charge calls by outcome (success or the failure reason)',
  });
  return (outcome) => counter.add(1, { outcome });
}
