# Promoting a tenant from pooled to siloed

Deferred work (plan: "After step 27"); follow PRD §10.3 when it exists. The two steps not to skip:

1. Verify row counts **and** checksums per tenant table before cutover (`TENANT_TABLES` is the list).
2. Retain the source rows afterwards, so the change is reversible for a defined window.

`tenant.db_ref` is the hook; nothing reads it yet.
