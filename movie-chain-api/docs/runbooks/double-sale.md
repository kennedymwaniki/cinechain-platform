# DoubleSale fired

**Should be impossible.** One seat at one screening is one `seat_lock` row (primary key), and a
sale is a conditional update of a live hold. If this fires, a core guarantee broke. Page.

1. Stop the bleeding: if it repeats, close sales on the affected screening (`POST /screenings/:id/close`).
2. Find the seats:
   ```sql
   SELECT screening_id, seat_id, count(*) FROM ticket WHERE status <> 'void' AND tenant_id = '<t>'
    GROUP BY 1, 2 HAVING count(*) > 1;
   ```
3. Look for a code path writing `seat_lock` or `ticket` outside `BookingRepository.convert`, and
   for a migration that touched `seat_lock`'s primary key or `ticket_seat_live_idx`.
4. Refund one of the two buyers (`POST /bookings/:id/cancel` with that booking's link, or a refund
   intent through `RefundService`) and contact them.
