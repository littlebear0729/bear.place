-- KEYS[1]=canvas:{canvas}:data  KEYS[2]=ratelimit:<uid>
-- KEYS[3]=canvas:{canvas}:seq   KEYS[4]=idempotency:pixel:<uid>:<rid>
-- KEYS[5]=canvas:{canvas}:stream
-- ARGV[1]=offset  ARGV[2]=color 单字节  ARGV[3]=ttl 秒
-- ARGV[4]=maxOffset  ARGV[5]=now_ms
-- 返回 {0,cached} | {-1,ttl} | {-2} | {1,seq,ttl}

local cached = redis.call('GET', KEYS[4])
if cached then return {0, cached} end

local off, maxOff = tonumber(ARGV[1]), tonumber(ARGV[4])
if not off or off < 0 or off >= maxOff then return {-2} end

local ttl = tonumber(ARGV[3])
if not redis.call('SET', KEYS[2], '1', 'NX', 'EX', ttl) then
  return {-1, redis.call('TTL', KEYS[2])}
end

local color = string.byte(ARGV[2])
redis.call('SETRANGE', KEYS[1], off, ARGV[2])
local seq = redis.call('INCR', KEYS[3])
redis.call('XADD', KEYS[5], 'MAXLEN', '~', 200000, seq .. '-0',
           's', seq, 'i', off, 'c', color)
redis.call('PUBLISH', 'canvas:updates',
           cjson.encode({s = seq, i = off, c = color, t = tonumber(ARGV[5])}))

local body = cjson.encode({seq = seq,
                           next_placement_at = tonumber(ARGV[5]) + ttl * 1000})
redis.call('SET', KEYS[4], body, 'EX', 10)
return {1, seq, ttl}
