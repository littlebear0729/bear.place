import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Redis } from 'ioredis';
import pg from 'pg';
import { config } from './config.js';
import { createApp } from './http.js';
import { attachWebSocket } from './ws.js';
import { initPublisher } from './events.js';
import { loadPlaceScript } from './placement.js';

const { Pool } = pg;

async function waitForRedis(redis: Redis, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await redis.ping();
      return;
    } catch {
      await delay(250);
    }
  }
  throw new Error('redis_not_ready');
}

async function main(): Promise<void> {
  const redis = new Redis(config.redisUrl, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  const sub = new Redis(config.redisUrl, { maxRetriesPerRequest: 1 });
  const pool = new Pool({ connectionString: config.databaseUrl, max: 5 });

  redis.on('error', (error) => console.error('[redis]', error.message));
  sub.on('error', (error) => console.error('[redis:sub]', error.message));
  pool.on('error', (error) => console.error('[pg]', error.message));

  await waitForRedis(redis);
  await loadPlaceScript(redis);
  // MQ 连接失败不能阻塞 API 启动：放置先降级到 spool，发布器在后台重连。
  void initPublisher(config.amqpUrl, config.queueName, config.spoolDir);

  const app = createApp({ redis, pool });
  const server = http.createServer(app);
  const sockets = attachWebSocket(server, { redis, sub });

  server.listen(config.port, () => {
    console.log(`[api] listening on :${config.port}`);
  });

  const shutdown = async (signal: string) => {
    console.log(`[api] ${signal}, shutting down`);
    sockets.close();
    server.close();
    await Promise.allSettled([redis.quit(), sub.quit(), pool.end()]);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('[api] fatal', error);
  process.exit(1);
});
