# RedisUnavailable fired

Holds and bookings **keep working**: the hold path falls back to Postgres alone (the durable
`INSERT … ON CONFLICT` is a complete hold), and the breaker skips Redis for 10 s at a time.

1. Confirm bookings still succeed: `cinechain_hold_acquire_seconds_count{path="postgres"}` rising,
   5xx flat.
2. What degrades: the 5 s seat-map cache (reads hit Postgres), live seat-map events, background
   jobs (sweeper, notifications, reconciliation, exports) until Redis returns. Expired holds are
   still taken over by new holds directly.
3. Restore Redis. Then check the outbox backlog drained:
   ```sql
   SELECT tenant_id, count(*) FROM outbox_event WHERE processed_at IS NULL GROUP BY 1;
   ```
