# One tenant is degrading the platform

Alert: `NoisyNeighbour` (one tenant's p95 > 3× the median tenant's).

1. Confirm with per-tenant rate and latency:
   ```promql
   sum by (tenant) (rate(cinechain_http_request_duration_seconds_count[5m]))
   histogram_quantile(0.95, sum by (tenant, le) (rate(cinechain_http_request_duration_seconds_bucket[5m])))
   ```
   If `tenant="other"` is the culprit, the busiest tenants are already labelled individually: look
   at the logs (`tenant_id` is on every line) to find which tenant inside the bucket.
2. **Tighten that tenant's ingress rate limit first** — it takes effect in seconds and protects
   everyone else immediately (per-tenant limits: step 25).
3. Then scale the API instances.
4. If it recurs, the tenant belongs on a dedicated database: a commercial conversation, not an
   engineering one.
