-- Sliding-window rate limit (two fixed windows, weighted), one atomic script.
-- The clock is REDIS's (TIME), so every API instance shares one notion of now.
-- KEYS[1]: the subject's base key, e.g. rl:{t:<tenant_id>} (one hash tag: one slot)
-- ARGV:    limit (requests per window), window_ms
-- Returns: {allowed (1|0), estimated count, retry_after_ms}
local limit, window = tonumber(ARGV[1]), tonumber(ARGV[2])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local idx = math.floor(now / window)
local elapsed = now - idx * window
local currKey, prevKey = KEYS[1] .. ':' .. idx, KEYS[1] .. ':' .. (idx - 1)
local curr = tonumber(redis.call('GET', currKey) or '0')
local prev = tonumber(redis.call('GET', prevKey) or '0')
local estimate = prev * (window - elapsed) / window + curr
if estimate >= limit then
  return {0, math.floor(estimate), window - elapsed}
end
redis.call('INCR', currKey)
redis.call('PEXPIRE', currKey, window * 2)
return {1, math.floor(estimate) + 1, 0}
