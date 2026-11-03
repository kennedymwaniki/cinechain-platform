# A seat shows as taken but the cinema is empty

**Almost always a stranded hold.** Alert: `SweeperLag`.

1. Find the seat's state. Redis key (note: tenant AND screening in one hash tag):
   ```bash
   redis-cli -p 6380 GET "lock:{t:<tenant_id>:scr:<screening_id>}:seat:<seat_id>"
   ```
   Durable row (as the admin role — it bypasses RLS, so name the tenant yourself):
   ```sql
   SELECT status, hold_id, expires_at, booking_id FROM seat_lock
    WHERE tenant_id = '<tenant_id>' AND screening_id = '<screening_id>' AND seat_id = '<seat_id>';
   ```
2. Interpret:
   - `status = 'sold'` with a `booking_id`: it is sold. Look the booking up; this is not a stranded hold.
   - `status = 'held'`, `expires_at` in the past, **no Redis key**: the sweeper has stalled. The seat is
     still sellable (a new hold takes over an expired row directly), but the seat map may lag.
   - `status = 'held'`, `expires_at` in the future: a live hold. Wait for it.
3. If the sweeper stalled: check `sweeper:tick:*` keys and the `inventory.sweeper` queue in Redis
   (`cinechain:inventory.sweeper:*`), and that some API instance has `SWEEPER_DATABASE_URL` set.
   The instance log says `the hold sweeper does not run in this process` when it is missing.
4. Resolve by deleting **the specific row**:
   ```sql
   DELETE FROM seat_lock WHERE tenant_id = '<t>' AND screening_id = '<s>' AND seat_id = '<seat>'
      AND status = 'held' AND expires_at < now();
   ```
   **Never flush Redis.** It drops every live hold across every tenant.
