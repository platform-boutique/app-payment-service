# Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `50051` | gRPC listen port. **Must be set when relying on the Docker `HEALTHCHECK`** (see below) |
| `NODE_ENV` | `production` (set in image) | |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset (telemetry off) | OTLP/**gRPC** endpoint for **traces, metrics and logs** (scheme required), e.g. `http://alloy.monitoring.svc.cluster.local:4317`. Legacy fallback: `COLLECTOR_SERVICE_ADDR` (`host:port`). Telemetry is on **only if** one of them is set and non-empty |
| `OTEL_SDK_DISABLED` | unset | `true` forces traces/metrics/logs export off even if an endpoint is set (standard OpenTelemetry switch) |
| `ENABLE_TRACING` | unset | Legacy switch: `0` forces traces/metrics/logs export off as well |
| `OTEL_METRIC_EXPORT_INTERVAL` | `15000` | Milliseconds between metric pushes |
| `OTEL_SERVICE_NAME` | `payment-service` | `service.name` — becomes the Prometheus `job` and the Loki `service_name`; keep the default, dashboards depend on it |
| `SERVICE_VERSION` | `1.0.0` | `service.version` resource attribute |
| `PYROSCOPE_ADDR` | unset (profiling off) | Profiles use the Pyroscope SDK push protocol (**not** OTLP). Point it at Alloy (`http://alloy.monitoring.svc.cluster.local:4040`), which forwards to Pyroscope, or directly at Pyroscope. Profiling is on **only if** it is set and non-empty |
| `ENABLE_PROFILING` | unset | `0` forces profiling off even if `PYROSCOPE_ADDR` is set |

Notes:

- There are **no secrets** and no external credentials: the service never talks to a real processor.
- Telemetry is **pushed**, not scraped: traces, metrics and logs share one OTLP/gRPC endpoint (Alloy); profiles go to Pyroscope (via Alloy). `service.instance.id` is the pod hostname, so replicas stay distinct in Mimir.
- The former Prometheus endpoint (`METRICS_PORT`) no longer exists. Logs keep going to stdout and are additionally exported over OTLP with trace ids.
- With none of the endpoints set the service starts with telemetry and profiling **off**, makes no outbound connections and logs no connection errors; the startup line says what is on (`"telemetry":"off: no OTEL_EXPORTER_OTLP_ENDPOINT / COLLECTOR_SERVICE_ADDR","profiling":"off: no PYROSCOPE_ADDR"`). Deployments that set the endpoints explicitly behave as before. With telemetry off, logs still go to stdout (without trace ids). If an endpoint is set but unreachable, the exporters log errors and the service keeps serving.
