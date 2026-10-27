# payment-service

<div class="pd-hero" markdown>
<span class="pd-kicker">service · platform-demo</span>

A gRPC service that "processes" payments for the platform-demo e-commerce platform. It validates a credit card (number checksum, brand, expiry), simulates declines and processor errors for documented test cards, returns a random transaction ID, and simulates refunds. **No real payment provider is involved and nothing is persisted** — it is a simulation. It is stateless, has no downstream dependencies, and is called only by `checkout-service`.
</div>

<div class="pd-facts" markdown>
<div><span>Runtime</span><strong>Node 22</strong><small>TypeScript</small></div>
<div><span>Listens on</span><strong>50051</strong><small>gRPC</small></div>
<div><span>State</span><strong>Stateless</strong></div>
<div><span>Image</span><strong>payment-service</strong><small>mladenovskistefan/</small></div>
</div>

## Where it sits

Called by `checkout-service`. It has no downstream dependencies.

```mermaid
flowchart LR
  payment_service["<b>payment-service</b><br/>50051 (gRPC)"]:::me
  checkout_service["checkout-service"] --> payment_service
  classDef me stroke-width:3px;
```

## At a glance

| | |
|---|---|
| **Language / runtime** | TypeScript on Node.js 22 (`@grpc/grpc-js`) |
| **Image** | `mladenovskistefan/payment-service` |
| **Protocol / port** | gRPC (HTTP/2, plaintext) on `50051` |
| **Metrics** | Pushed over OTLP/gRPC to Alloy → Mimir every 15 s (no scrape endpoint). Dashboard names: `rpc_server_duration_seconds_{bucket,count,sum}`, `rpc_server_requests_total`, `rpc_server_active_requests` |
| **Health** | `grpc.health.v1.Health/Check` on `50051` — static `SERVING` |
| **State** | None |
| **Depends on** | Nothing (optional: OTLP collector, Pyroscope) |
| **Called by** | `checkout-service` (`Charge`; `Refund` is not called yet) |
| **gRPC reflection** | Not enabled — pass `-proto` to `grpcurl` |

## Find it elsewhere

<div class="pd-cards" markdown>
<div><h4><a href="https://argocd.platform-demo.click/applications/argocd/dev-payment-service">Argo CD</a></h4><p>Sync and health of <code>dev-payment-service</code>.</p></div>
<div><h4><a href="https://github.com/platform-boutique/app-payment-service">Repository</a></h4><p>Source, pull requests and releases of <code>app-payment-service</code>.</p></div>
</div>

!!! info "Part of the platform-demo platform"
    Cross-cutting facts (service wiring, observability contract, Kubernetes translation, CI/CD) are in the
    [master reference](https://github.com/platform-boutique/platform-demo-docs). This site only describes payment-service.
