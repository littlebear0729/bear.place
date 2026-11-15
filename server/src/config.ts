export const config = {
  port: Number(process.env.PORT ?? 3000),
  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  databaseUrl:
    process.env.DATABASE_URL ?? 'postgres://rplace:rplace_dev@127.0.0.1:5432/rplace',
  amqpUrl: process.env.AMQP_URL ?? 'amqp://rplace:rplace_dev@127.0.0.1:5672',
  canvasId: process.env.CANVAS_ID ?? 'main',
  cooldownSeconds: Number(process.env.COOLDOWN_SECONDS ?? 300),
  broadcastBatchMs: Number(process.env.BROADCAST_BATCH_MS ?? 100),
  authSecret: process.env.AUTH_SECRET ?? 'dev-only-secret',
  adminUsername: process.env.ADMIN_USERNAME ?? 'admin',
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? 'http://localhost:8080,http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  sessionTtlSeconds: Number(process.env.SESSION_TTL ?? 86400),
  spoolDir: process.env.SPOOL_DIR ?? '/var/lib/rplace/spool',
  queueName: 'pixel.events',
};
