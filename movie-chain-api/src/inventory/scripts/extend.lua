-- Re-arms our keys to the durable row's new expiry. A key that vanished
-- (eviction, restart) is re-created: Postgres already granted the extension.
-- A key held by someone else is left alone and reported.
-- KEYS: one lock key per seat, then the manifest
-- ARGV: hold_id, ttl_ms, seat_count
local n, holdId, ttl = tonumber(ARGV[3]), ARGV[1], tonumber(ARGV[2])
local foreign = 0
for i = 1, n do
  local cur = redis.call('GET', KEYS[i])
  if cur and cur ~= holdId then
    foreign = foreign + 1
  else
    redis.call('SET', KEYS[i], holdId, 'PX', ttl)
  end
end
redis.call('PEXPIRE', KEYS[n + 1], ttl)
return foreign
