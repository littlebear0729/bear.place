import { Redis } from 'ioredis';
import pg from 'pg';
import { config } from './config.js';
import { keys } from './constants.js';
import {
  ensureSchema,
  loadConfigFromDb,
  storeCanvasConfig,
  type CanvasConfig,
} from './canvas-config.js';

const { Pool } = pg;

const REPLAY_BATCH = 5000;

async function restore(
  redis: Redis,
  pool: pg.Pool,
  canvas: CanvasConfig,
): Promise<void> {
  const seqKey = keys.seq(config.canvasId);
  const dataKey = keys.data(config.canvasId);
  const pixelCount = canvas.width * canvas.height;

  if ((await redis.exists(seqKey)) === 1) {
    const length = await redis.strlen(dataKey);
    if (length === 0) await redis.set(dataKey, Buffer.alloc(pixelCount));
    console.log('[init] canvas already initialized, nothing to do');
    return;
  }

  const { rows: snapshots } = await pool.query<{ seq: string; canvas_data: Buffer }>(
    `SELECT seq, canvas_data FROM canvas_snapshots
      WHERE canvas_id = $1
        AND seq >= $2
        AND octet_length(canvas_data) = $3
      ORDER BY id DESC
      LIMIT 1`,
    [config.canvasId, canvas.epochSeq, pixelCount],
  );

  const snapshot = snapshots[0];
  const padded = Buffer.alloc(pixelCount);
  if (snapshot) {
    snapshot.canvas_data.copy(
      padded,
      0,
      0,
      Math.min(snapshot.canvas_data.length, pixelCount),
    );
  }
  await redis.set(dataKey, padded);

  // 以快照与配置纪元中较新的水位为起点，避免回放触发缩放前的事件。
  let watermark = snapshot ? Number(snapshot.seq) : canvas.epochSeq;
  for (;;) {
    const { rows } = await pool.query<{
      seq: string;
      x: number;
      y: number;
      color: number;
    }>(
      `SELECT seq, x, y, color FROM pixel_events
        WHERE seq > $1
        ORDER BY seq
        LIMIT $2`,
      [watermark, REPLAY_BATCH],
    );
    if (rows.length === 0) break;

    const pipeline = redis.pipeline();
    for (const row of rows) {
      const x = Number(row.x);
      const y = Number(row.y);
      const color = Number(row.color);
      if (x < 0 || x >= canvas.width || y < 0 || y >= canvas.height) continue;
      if (color < 0 || color >= canvas.palette.length) continue;
      pipeline.setrange(dataKey, y * canvas.width + x, Buffer.from([color]));
    }
    await pipeline.exec();
    watermark = Number(rows[rows.length - 1].seq);
    if (rows.length < REPLAY_BATCH) break;
  }

  await redis.set(seqKey, String(watermark));
  console.log(
    `[init] restored ${canvas.width}x${canvas.height} canvas at seq ${watermark} ` +
      `(snapshot=${snapshot ? snapshot.seq : 'none'}, epoch=${canvas.epochSeq})`,
  );
}

async function main(): Promise<void> {
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1 });
  const pool = new Pool({ connectionString: config.databaseUrl, max: 2 });

  try {
    await ensureSchema(pool);
    const canvas = await loadConfigFromDb(pool, config.canvasId);
    await storeCanvasConfig(redis, config.canvasId, canvas);
    await restore(redis, pool, canvas);
  } finally {
    await Promise.allSettled([redis.quit(), pool.end()]);
  }
}

main().catch((error) => {
  console.error('[init] fatal', error);
  process.exit(1);
});
