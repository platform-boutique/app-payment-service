# Kubernetes

**Workload:** stateless `Deployment`; scale freely.

**Ports to declare**

| Name | Port | Protocol | Expose via Service? |
|---|---|---|---|
| `grpc` | `50051` | TCP (HTTP/2) | Yes — `checkout-service` dials `payment-service:50051` |

**Service DNS name expected by callers:** `payment-service` (`checkout-service`: `PAYMENT_SERVICE_ADDR=payment-service:50051`). Note the same port number (`50051`) is also used by `shipping-service` — they are different Services, so no clash.

**Probes**

```yaml
readinessProbe:
  grpc: { port: 50051 }
  initialDelaySeconds: 3
  periodSeconds: 5
livenessProbe:
  grpc: { port: 50051 }
  periodSeconds: 10
  failureThreshold: 3
```

(The Node health handler implements `Check` only; `grpc:` probes only call `Check`.)

**Graceful shutdown:** on `SIGTERM` (or `SIGINT`) the service flushes OpenTelemetry/Pyroscope (at most 3 s), then exits with code 0. In-flight RPCs are not drained first. `terminationGracePeriodSeconds: 5` is enough.

**Security context**

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 100
  runAsGroup: 101
  allowPrivilegeEscalation: false
  capabilities: { drop: ["ALL"] }
  readOnlyRootFilesystem: true   # verified (no /tmp needed)
```

**Resources** — requests sized from measured idle usage in the test stack (see the chart's `values.yaml` for limits):

```yaml
resources:
  requests: { cpu: 100m, memory: 64Mi }
  limits:   { cpu: "500m", memory: 192Mi }
```

**Config / secrets:** none. Plain env only.

**Network policy:** only `checkout-service` should be allowed to reach port `50051`; this service handles card data.

**Telemetry:** pushed, not scraped — OTLP/gRPC to Alloy (`global.monitoring.otlpEndpoint`), profiles to Alloy `:4040`. Metrics carry `job="payment-service"` and `instance=<pod>`; no scrape annotations or `ServiceMonitor` are needed.

**Helm chart:** [`platform-demo-helm/payment-service`](https://github.com/platform-boutique/platform-demo-helm/tree/main/payment-service) (built on the shared `platform-common` library chart). It ships with HA defaults — 2 replicas,
HPA, PodDisruptionBudget, topology spread, NetworkPolicy, restricted pod security context, probes and the full env contract (see Configuration) —
and was verified in the earlier local phase on a 3-node kind cluster (since deleted) under the `restricted` Pod Security Standard; it has not been verified on EKS yet.

**Deployment and admission policies:** Argo CD deploys the chart from `platform-demo-helm` (`envs/<env>/values/payment-service.yaml` pins the image digest; promotion is a pull request). In the cluster Kyverno enforces, for this service: pods named `app.kubernetes.io/name: payment-service` that run under the ServiceAccount of the same name (Cilium derives the network identity from that label), an image from this repository pinned by digest and signed by our release pipeline, a read-only root filesystem, resource requests and a memory limit, readiness and liveness probes and no API token. The Helm CI evaluates the rendered chart against these policies before merge; see [`platform-demo-helm/policies`](https://github.com/platform-boutique/platform-demo-helm/tree/main/policies).
