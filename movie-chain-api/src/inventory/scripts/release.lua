-- Deletes ONLY keys whose value is still our hold id. A hold that expired and
-- was re-acquired by someone else belongs to them: deleting it would hand a
-- stranger's seat to a third party (the classic distributed-lock bug).
-- KEYS: one lock key per seat, then the manifest, then the seat-map version
-- ARGV: hold_id, seat_count
local n, holdId = tonumber(ARGV[2]), ARGV[1]
local released = 0
for i = 1, n do
  if redis.call('GET', KEYS[i]) == holdId then
    redis.call('DEL', KEYS[i])
    released = released + 1
  end
end
redis.call('DEL', KEYS[n + 1])
if released > 0 then return {released, redis.call('INCR', KEYS[n + 2])} end
return {0, tonumber(redis.call('GET', KEYS[n + 2]) or '0')}
