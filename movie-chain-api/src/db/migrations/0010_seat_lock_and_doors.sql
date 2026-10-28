-- run-as: migrator
-- Step 12: the seat-at-a-screening table, and the public read doors.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX film_title_trgm_idx ON film USING gin (title gin_trgm_ops);   -- FR-34 title search

CREATE TYPE lock_status AS ENUM ('held', 'sold');

-- One row = one seat at one screening. THE guarantee: the primary key.
CREATE TABLE seat_lock (
  screening_id uuid NOT NULL,
  seat_id      uuid NOT NULL,
  tenant_id    uuid NOT NULL,
  status       lock_status NOT NULL,
  hold_id      uuid,                 -- who owns the hold
  expires_at   timestamptz,          -- NULL once sold
  booking_id   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (screening_id, seat_id),
  CHECK (status = 'sold' OR expires_at IS NOT NULL),
  FOREIGN KEY (tenant_id, screening_id) REFERENCES screening (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, seat_id)      REFERENCES seat (tenant_id, id)      ON DELETE RESTRICT
);
-- the hot path: "the whole seat map for this screening"
CREATE INDEX seat_lock_screening_idx ON seat_lock (screening_id) INCLUDE (seat_id, status, expires_at);
-- the sweeper's query (step 15)
CREATE INDEX seat_lock_expiry_idx ON seat_lock (expires_at) WHERE status = 'held';

-- ===========================================================================
-- SANCTIONED CROSS-TENANT READ DOORS. Reviewed as security code. Each is
-- owned by cinechain_resolver (NOLOGIN, BYPASSRLS, column grants only): a
-- door owned by the table owner would see nothing under FORCE RLS.
-- The allowlist in test/isolation/schema-guard.spec.ts must match.
-- ===========================================================================

-- Door 1. A guest names a screening; the server learns whose it is.
-- Returns ONLY the tenant id, ONLY for a published screening of an active
-- chain. A draft, a cancelled one and one that does not exist are identical.
CREATE FUNCTION resolve_published_screening(p_id uuid)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT s.tenant_id
    FROM screening s JOIN tenant t ON t.id = s.tenant_id
   WHERE s.id = p_id AND s.status = 'published' AND t.status = 'active';
$$;

-- Door 2. Cross-chain browsing (FR-30, FR-31, FR-34, FR-75): every chain's
-- PUBLISHED showtimes in a town and date range. Returns what a cinema prints
-- on a poster — film, theatre, time, format — and nothing about demand: no
-- seat counts, no holds, no sales. Capped at 60 days ahead and 2000 rows.
CREATE FUNCTION public_showtimes(
  p_city text, p_from timestamptz, p_to timestamptz,
  p_film uuid, p_title text, p_language text, p_rating text, p_format text)
RETURNS TABLE (
  tenant_id uuid, chain_slug text, chain_name text,
  theatre_id uuid, theatre_name text, city text, timezone text,
  screen_id uuid, film_id uuid, title text, runtime_min int, rating text,
  language text, poster_key text, screening_id uuid, starts_at timestamptz, format text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT s.tenant_id, tn.slug, tn.name,
         th.id, th.name, th.city, th.timezone,
         s.screen_id, f.id, f.title, f.runtime_min, f.rating,
         f.language, f.poster_key, s.id, s.starts_at, s.format
    FROM screening s
    JOIN tenant  tn ON tn.id = s.tenant_id AND tn.status = 'active'
    JOIN screen  sc ON sc.tenant_id = s.tenant_id AND sc.id = s.screen_id
    JOIN theatre th ON th.tenant_id = s.tenant_id AND th.id = sc.theatre_id
    JOIN film    f  ON f.tenant_id  = s.tenant_id AND f.id  = s.film_id
   WHERE s.status = 'published'
     AND s.starts_at >= greatest(p_from, now())
     AND s.starts_at <  least(p_to, now() + interval '60 days')
     AND (p_city     IS NULL OR lower(th.city) = lower(p_city))
     AND (p_film     IS NULL OR f.id = p_film)
     AND (p_title    IS NULL OR f.title ILIKE '%' || replace(replace(replace(p_title, '\', '\\'), '%', '\%'), '_', '\_') || '%')
     AND (p_language IS NULL OR lower(f.language) = lower(p_language))
     AND (p_rating   IS NULL OR f.rating = p_rating)
     AND (p_format   IS NULL OR s.format = p_format)
   ORDER BY s.starts_at, s.id
   LIMIT 2000;
$$;

-- Column-level grants: exactly what the two doors read, nothing more.
GRANT SELECT (id, tenant_id, status, screen_id, film_id, starts_at, format) ON screening TO cinechain_resolver;
GRANT SELECT (id, tenant_id, theatre_id)                                    ON screen    TO cinechain_resolver;
GRANT SELECT (id, tenant_id, name, city, timezone)                          ON theatre   TO cinechain_resolver;
GRANT SELECT (id, tenant_id, title, runtime_min, rating, language, poster_key) ON film   TO cinechain_resolver;
GRANT SELECT (id, slug, name, status)                                       ON tenant    TO cinechain_resolver;

ALTER FUNCTION resolve_published_screening(uuid) OWNER TO cinechain_resolver;
ALTER FUNCTION public_showtimes(text, timestamptz, timestamptz, uuid, text, text, text, text) OWNER TO cinechain_resolver;
REVOKE ALL ON FUNCTION resolve_published_screening(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_showtimes(text, timestamptz, timestamptz, uuid, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_published_screening(uuid) TO cinechain_app;
GRANT EXECUTE ON FUNCTION public_showtimes(text, timestamptz, timestamptz, uuid, text, text, text, text) TO cinechain_app;
