import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { createPaymentOutcomeCounter, registerBuildInfo } from '../src/metrics';

// A reader that is only collected by hand: the interval is far beyond the test, so no timer ever fires.
function setup() {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 3_600_000,
  });
  const provider = new MeterProvider({ readers: [reader] });
  return {
    meter: provider.getMeter('test'),
    async collect() {
      const { resourceMetrics } = await reader.collect();
      return resourceMetrics.scopeMetrics.flatMap((s) => s.metrics);
    },
    shutdown: () => provider.shutdown(),
  };
}

describe('build_info', () => {
  it('is 1 with service, version and commit labels', async () => {
    const t = setup();
    registerBuildInfo(t.meter, {
      serviceName: 'payment-service',
      serviceVersion: '1.2.3',
      serviceCommit: 'abc1234',
    });
    const metric = (await t.collect()).find((m) => m.descriptor.name === 'build_info');
    expect(metric).toBeDefined();
    expect(metric!.dataPoints).toHaveLength(1);
    expect(metric!.dataPoints[0].value).toBe(1);
    expect(metric!.dataPoints[0].attributes).toEqual({
      service: 'payment-service',
      version: '1.2.3',
      commit: 'abc1234',
    });
    await t.shutdown();
  });
});

describe('payment_charges_total', () => {
  it('counts per outcome label and nothing else', async () => {
    const t = setup();
    const record = createPaymentOutcomeCounter(t.meter);
    record('success');
    record('success');
    record('card_declined');
    const metric = (await t.collect()).find((m) => m.descriptor.name === 'payment_charges_total');
    expect(metric).toBeDefined();
    const byOutcome = Object.fromEntries(
      metric!.dataPoints.map((p) => [p.attributes.outcome, p.value]),
    );
    expect(byOutcome).toEqual({ success: 2, card_declined: 1 });
    for (const p of metric!.dataPoints) expect(Object.keys(p.attributes)).toEqual(['outcome']);
    await t.shutdown();
  });
});
