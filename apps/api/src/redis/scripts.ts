import type { Redis } from 'ioredis';

function isNoScriptError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('NOSCRIPT');
}

export class LuaScript<T> {
  private sha: string | undefined;

  constructor(
    private readonly source: string,
    private readonly numberOfKeys: number,
  ) {}

  async run(client: Redis, keys: string[], args: (string | number)[]): Promise<T> {
    try {
      this.sha ??= (await client.script('LOAD', this.source)) as string;
      return (await client.evalsha(this.sha, this.numberOfKeys, ...keys, ...args)) as T;
    } catch (error) {
      if (!isNoScriptError(error)) {
        throw error;
      }
      this.sha = undefined;
      return (await client.eval(this.source, this.numberOfKeys, ...keys, ...args)) as T;
    }
  }
}

export const TOKEN_BUCKET_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillPerMs = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local ttlMs = tonumber(ARGV[4])

local time = redis.call('TIME')
local nowMs = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)

local stored = redis.call('HMGET', key, 'tokens', 'updatedAt')
local tokens = tonumber(stored[1])
local updatedAt = tonumber(stored[2])

if tokens == nil or updatedAt == nil then
  tokens = capacity
  updatedAt = nowMs
end

local elapsed = nowMs - updatedAt
if elapsed < 0 then
  elapsed = 0
end

tokens = math.min(capacity, tokens + (elapsed * refillPerMs))

local allowed = 0
local retryAfterMs = 0

if tokens >= cost then
  allowed = 1
  tokens = tokens - cost
else
  retryAfterMs = math.ceil((cost - tokens) / refillPerMs)
end

redis.call('HSET', key, 'tokens', tostring(tokens), 'updatedAt', tostring(nowMs))
redis.call('PEXPIRE', key, ttlMs)

return { allowed, math.floor(tokens), retryAfterMs }
`;

export const RENEW_LEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
end
return 0
`;

export const RELEASE_LEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;
