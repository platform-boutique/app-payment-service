# Observability

| Signal | Implementation | Destination |
|---|---|---|
| **Traces** | OpenTelemetry `NodeSDK` + `GrpcInstrumentation`, OTLP/gRPC exporter (`BatchSpanProcessor`) | Alloy `:4317` → Tempo |
| **Metrics** | Hand-rolled RPC instruments (`GrpcInstrumentation` emits traces only) + Node runtime gauges, `PeriodicExportingMetricReader` over OTLP/gRPC every 15 s (replaces the Prometheus exporter) | Alloy → Mimir |
| **Logs** | `pino` JSON to stdout in the shared shape (`timestamp`, `severity`, `message`, `service`, `version`, `trace_id`, `span_id`, `error`; `trace_id`/`span_id` come from the active span via a pino `mixin`) **and** `@opentelemetry/instrumentation-pino` forwarding records over OTLP/gRPC (log correlation of that instrumentation is off, so there is no duplicate field) | stdout → Alloy → Loki; OTLP → Alloy → Loki |
| **Profiles** | `@pyroscope/nodejs`, only with `PYROSCOPE_ADDR`; tags `service_name`, `version`, `environment` | Alloy `:4040` → Pyroscope |

Metric names: `rpc_server_duration_seconds_{bucket,count,sum}` (buckets 1 ms … 10 s; the unit `s` yields the `_seconds` suffix), `rpc_server_requests_total`, `rpc_server_active_requests` (labels `rpc_system`, `rpc_service`, `rpc_method`, `rpc_grpc_status_code`), plus `nodejs_*` runtime gauges (heap, RSS, CPU, event-loop lag, active handles). The event-loop lag is sampled with Node's `monitorEventLoopDelay` histogram — the earlier self-rescheduling `setTimeout(0)` probe kept an idle pod at ~25 % CPU, which would have kept an HPA scaling out.

Every series carries `job="payment-service"` (from `service.name`) and `instance=<pod name>` (`service.instance.id`), which is what the Grafana dashboards select on. Logs land in Loki with `service_name="payment-service"` and trace/span ids, so a log line links to its trace.

Metrics are pushed over OTLP (RED series above); this service has no Prometheus `/metrics` endpoint and none is planned (OBS-20 allows OTLP push for non-Go services). `service.version` comes from `SERVICE_VERSION` (default `dev`) and is logged once, with the commit, in the `starting` line.
