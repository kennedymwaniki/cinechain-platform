# Payment provider outage during an on-sale

Alert (related): `SeatsLostAfterCapture` — captures succeeding after holds expired.

1. Extend hold windows via configuration so customers mid-flow are not penalised:
   raise `tenant.hold_seconds` (120–900) for the affected chains.
2. Display a banner.
3. **Do not retry captures blindly.** Every capture is keyed on the booking id; a stuck payment is
   resolved by asking the provider (`status(idempotency key)`), never by charging again. The
   reconciler (`booking.reconcile`, every minute) already does this, and refunds any capture whose
   booking never confirmed.
4. Watch `cinechain_booking_seats_lost_after_capture_total` and pending refunds:
   ```sql
   SELECT tenant_id, count(*) FROM payment_refund WHERE status = 'pending' GROUP BY 1;
   ```
