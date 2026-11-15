import amqp from 'amqplib';
import { Redis } from 'ioredis';
import pg from 'pg';
import { config } from './config.js';
import { keys } from './constants.js';
import { ensureSchema, loadCanvasConfig } from './canvas-config.js';
import { canvasSeq, persistenceQueueDepth } from './metrics.js';
import { drainSpool, type PixelEvent } from './spool.js';
import { isRecord } from './guards.js';

const { Pool } = pg;

function parseEvent(raw: string): PixelEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { seq, user_id, x, y, color, placed_at, request_id } = parsed;
  if (
    typeof seq !== 'number' || !Number.isInteger(seq) ||
    typeof user_id !== 'number' || !Number.isInteger(user_id) ||
    typeof x !== 'number' || !Number.isInteger(x) ||
    typeof y !== 'number' || !Number.isInteger(y) ||
    typeof color !== 'number' || !Number.isInteger(color) ||
    typeof placed_at !== 'number' || !Number.isFinite(placed_at) ||
    typeof request_id !== 'string'
  ) {
    return null;
  }
  return { seq, user_id, x, y, color, placed_at, request_id };
}

const BATCH_SIZE = 500;
const BATCH_WINDOW_MS = 200;
const SNAPSHOT_INTERVAL_MS = 30_000;
const PRUNE_INTERVAL_MS = 3_600_000;

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
  const redis = new Redis(config.redisUrl, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  pool.on('error', (error) => console.error('[pg]', error.message));
  redis.on('error', (error) => console.error('[redis]', error.message));
  await ensureSchema(pool);
  let stopping = false;

  const insertEvents = async (events: PixelEvent[]): Promise<void> => {
    if (events.length === 0) return;
    const tuples: string[] = [];
    const values: unknown[] = [];
    events.forEach((event, index) => {
      const base = index * 7;
      tuples.push(
        `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7})`,
      );
      values.push(
        event.seq,
        event.user_id,
        event.x,
        event.y,
        event.color,
        new Date(event.placed_at),
        event.request_id,
      );
    });
    await pool.query(
      `INSERT INTO pixel_events (seq, user_id, x, y, color, placed_at, request_id)
       VALUES ${tuples.join(',')}
       ON CONFLICT DO NOTHING`,
      values,
    );
  };

  const takeSnapshot = async (): Promise<void> => {
    const reply = await redis
      .pipeline()
      .getBuffer(keys.data(config.canvasId))
      .get(keys.seq(config.canvasId))
      .exec();
    if (!reply) return;
    const data: unknown = reply[0]?.[1];
    if (!Buffer.isBuffer(data)) return;
    const seqRaw: unknown = reply[1]?.[1];
    const seq = typeof seqRaw === 'string' ? Number(seqRaw) : 0;
    const canvas = await loadCanvasConfig(redis, pool, config.canvasId);
    const pixelCount = canvas.width * canvas.height;
    const padded = Buffer.alloc(pixelCount);
    data.copy(padded, 0, 0, Math.min(data.length, pixelCount));
    canvasSeq.set(seq);
    await pool.query(
      `INSERT INTO canvas_snapshots (canvas_id, seq, canvas_data) VALUES ($1, $2, $3)`,
      [config.canvasId, seq, padded],
    );
  };

  const pruneSnapshots = async (): Promise<void> => {
    await pool.query(
      `DELETE FROM canvas_snapshots
        WHERE canvas_id = $1
          AND created_at < now() - interval '24 hours'
          AND id NOT IN (
            SELECT DISTINCT ON (date_trunc('hour', created_at)) id
              FROM canvas_snapshots
             WHERE canvas_id = $1
               AND created_at < now() - interval '24 hours'
             ORDER BY date_trunc('hour', created_at), id DESC
          )`,
      [config.canvasId],
    );
  };

  const spoolTimer = setInterval(() => {
    void drainSpool(config.spoolDir, insertEvents)
      .then((count) => {
        if (count > 0) console.log(`[worker] spool drained ${count} events`);
      })
      .catch((error) => console.error('[worker] spool drain failed', error));
  }, 10_000);

  const snapshotTimer = setInterval(() => {
    void takeSnapshot().catch((error) => console.error('[worker] snapshot failed', error));
  }, SNAPSHOT_INTERVAL_MS);

  const pruneTimer = setInterval(() => {
    void pruneSnapshots().catch((error) => console.error('[worker] prune failed', error));
  }, PRUNE_INTERVAL_MS);

  const connection = await amqp.connect(config.amqpUrl);
  connection.on('error', (error) => console.error('[worker] amqp error', error.message));
  connection.on('close', () => {
    if (stopping) return;
    console.error('[worker] amqp connection closed, exiting for restart');
    process.exit(1);
  });
  const channel = await connection.createChannel();
  channel.on('error', (error) => console.error('[worker] channel error', error.message));
  channel.on('close', () => {
    if (stopping) return;
    console.error('[worker] amqp channel closed, exiting for restart');
    process.exit(1);
  });
  await channel.assertQueue(config.queueName, { durable: true });
  channel.prefetch(BATCH_SIZE);

  let batch: amqp.ConsumeMessage[] = [];
  let flushTimer: NodeJS.Timeout | null = null;
  let flushing: Promise<void> = Promise.resolve();

  const flush = (): Promise<void> => {
    const messages = batch;
    batch = [];
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (messages.length === 0) return Promise.resolve();

    flushing = flushing
      .then(async () => {
        const events: PixelEvent[] = [];
        for (const message of messages) {
          const event = parseEvent(message.content.toString('utf8'));
          if (event) events.push(event);
        }
        await insertEvents(events);
        for (const message of messages) channel.ack(message);
      })
      .catch((error) => {
        console.error('[worker] batch failed', error);
        for (const message of messages) channel.nack(message, false, true);
      });
    return flushing;
  };

  channel.consume(config.queueName, (message) => {
    if (!message) return;
    batch.push(message);
    if (batch.length >= BATCH_SIZE) {
      void flush();
      return;
    }
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        void flush();
      }, BATCH_WINDOW_MS);
    }
  });

  const depthTimer = setInterval(() => {
    void channel
      .checkQueue(config.queueName)
      .then((info) => persistenceQueueDepth.set(info.messageCount))
      .catch(() => persistenceQueueDepth.set(0));
  }, 10_000);

  void drainSpool(config.spoolDir, insertEvents)
    .then((count) => {
      if (count > 0) console.log(`[worker] spool drained ${count} events`);
    })
    .catch((error) => console.error('[worker] initial spool drain failed', error));

  const shutdown = async (signal: string) => {
    stopping = true;
    console.log(`[worker] , shutting down`);
    clearInterval(spoolTimer);
    clearInterval(snapshotTimer);
    clearInterval(pruneTimer);
    clearInterval(depthTimer);
    await flush();
    await channel.close().catch(() => undefined);
    await connection.close().catch(() => undefined);
    await Promise.allSettled([redis.quit(), pool.end()]);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  console.log('[worker] consuming', config.queueName);
}

main().catch((error) => {
  console.error('[worker] fatal', error);
  process.exit(1);
});
