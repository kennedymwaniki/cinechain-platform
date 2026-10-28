-- All-or-nothing hold on several seats. One EVALSHA; nothing is written
-- unless EVERY seat is free (or already ours: a retry is idempotent).
-- KEYS: one lock key per seat, then the manifest, then the seat-map version
-- ARGV: hold_id, ttl_ms, manifest_json, seat_count, contested_prefix, contested_suffix
local n, holdId, ttl = tonumber(ARGV[4]), ARGV[1], tonumber(ARGV[2])
local conflicts = {}
for i = 1, n do
  local cur = redis.call('GET', KEYS[i])
  if cur and cur ~= holdId then
    conflicts[#conflicts + 1] = i
    -- FR-45: someone is waiting on the holder's seats, so it may not extend.
    -- Same hash tag as KEYS, so the same slot under cluster mode.
    redis.call('SET', ARGV[5] .. cur .. ARGV[6], '1', 'PX', 900000)
  end
end
if #conflicts > 0 then
  local out = {0}
  for i = 1, #conflicts do out[#out + 1] = conflicts[i] end
  return out                                   -- NOTHING written: all-or-nothing
end
for i = 1, n do redis.call('SET', KEYS[i], holdId, 'PX', ttl) end
redis.call('SET', KEYS[n + 1], ARGV[3], 'PX', ttl)
return {1, ttl, redis.call('INCR', KEYS[n + 2])}
