# Runbooks

One page per situation, from PRD §14.3, plus one per page-severity alert in
`deploy/alerts/cinechain.rules.yml`. Every log line and metric carries the
tenant (`tenant_id` in logs, `tenant` on metrics: the ~50 busiest tenants by id,
the rest as `other`), so the first question — *for whom?* — is usually answered
by the alert itself.

| Situation | Page |
|---|---|
| A seat shows as taken but the cinema is empty | [seat-taken-but-empty.md](seat-taken-but-empty.md) |
| One tenant is degrading the platform | [noisy-neighbour.md](noisy-neighbour.md) |
| A tenant reports seeing another tenant's data | [cross-tenant-data.md](cross-tenant-data.md) |
| Payment provider outage during an on-sale | [payment-provider-outage.md](payment-provider-outage.md) |
| Promoting a tenant from pooled to siloed | [pooled-to-siloed.md](pooled-to-siloed.md) |
| `DoubleSale` fired | [double-sale.md](double-sale.md) |
| `OnboardingStuck` fired | [onboarding-stuck.md](onboarding-stuck.md) |
| `RedisUnavailable` fired | [redis-down.md](redis-down.md) |
