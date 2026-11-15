import { readFileSync } from 'node:fs';
import type { Redis } from 'ioredis';
import { keys } from './constants.js';

const luaSource = readFileSync(new URL('./place.lua', import.meta.url), 'utf8');
let sha: string | null = null;

export type PlaceResult =
  | { kind: 'ok'; seq: number; ttl: number }
  | { kind: 'replay'; body: string }
  | { kind: 'cooldown'; ttl: number }
  | { kind: 'invalid' }
  | { kind: 'invalid_color' };

export async function loadPlaceScript(redis: Redis): Promise<string> {
  sha = (await redis.script('LOAD', luaSource)) as string;
  return sha;
}

async function evalPlace(
  redis: Redis,
  keyList: string[],
  args: (string | Buffer)[],
): Promise<unknown> {
  if (!sha) await loadPlaceScript(redis);
  try {
    return await redis.evalsha(sha as string, keyList.length, ...keyList, ...args);
  } catch (error) {
    if (error instanceof Error && error.message.includes('NOSCRIPT')) {
      await loadPlaceScript(redis);
      return redis.evalsha(sha as string, keyList.length, ...keyList, ...args);
    }
    throw error;
  }
}

export async function placePixel(
  redis: Redis,
  params: {
    canvasId: string;
    userId: number;
    offset: number;
    color: number;
    requestId: string;
    cooldownSeconds: number;
    maxOffset: number;
    maxColor: number;
    nowMs: number;
  },
): Promise<PlaceResult> {
  const keyList = [
    keys.data(params.canvasId),
    keys.ratelimit(params.userId),
    keys.seq(params.canvasId),
    keys.idempotency(params.userId, params.requestId),
    keys.stream(params.canvasId),
  ];
  const args = [
    String(params.offset),
    Buffer.from([params.color]),
    String(params.cooldownSeconds),
    String(params.maxOffset),
    String(params.nowMs),
    String(params.maxColor),
  ];

  const raw = await evalPlace(redis, keyList, args);
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('unexpected_lua_reply');
  }
  const kind = Number(raw[0]);

  if (kind === 1) {
    return { kind: 'ok', seq: Number(raw[1]), ttl: Number(raw[2]) };
  }
  if (kind === 0) {
    return { kind: 'replay', body: String(raw[1]) };
  }
  if (kind === -1) {
    return { kind: 'cooldown', ttl: Number(raw[1]) };
  }
  if (kind === -3) {
    return { kind: 'invalid_color' };
  }
  return { kind: 'invalid' };
}
