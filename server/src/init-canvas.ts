import { Redis } from 'ioredis';
import pg from 'pg';
import { config } from './config.js';
import { CANVAS_WIDTH, PIXEL_COUNT, keys } from './constants.js';

const { Pool } = pg;

const REPLAY_BATCH = 5000;

async function main(): Promise<void> {
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1 });
  const pool = new Pool({ connectionString: config.databaseUrl, max: 2 });
  const seqKey = keys.seq(config.canvasId);
  const dataKey = keys.data(config.canvasId);

  try {
    if ((await redis.exists(seqKey)) === 1) {
      console.log('[init] canvas already initialized, nothing to do');
      return;
    }

    const { rows: snapshots } = await pool.query<{ seq: string; canvas_data: Buffer }>(
      `SELECT seq, canvas_data FROM canvas_snapshots
        WHERE canvas_id = $1
        ORDER BY id DESC
        LIMIT 1`,
      [config.canvasId],
    );

    const snapshot = snapshots[0];
    if (snapshot) {
      const padded = Buffer.alloc(PIXEL_COUNT);
      snapshot.canvas_data.copy(padded, 0, 0, Math.min(snapshot.canvas_data.length, PIXEL_COUNT));
      await redis.set(dataKey, padded);
    }

    // 以快照为起点回放其后的持久化事件，避免“快照间隔内的像素”永久丢失。
    let watermark = snapshot ? Number(snapshot.seq) : 0;
    for (;;) {
      const { rows } = await pool.query<{ seq: string; x: number; y: number; color: number }>(
        `SELECT seq, x, y, color FROM pixel_events
          WHERE seq > $1
          ORDER BY seq
          LIMIT $2`,
        [watermark, REPLAY_BATCH],
      );
      if (rows.length === 0) break;

      const pipeline = redis.pipeline();
      for (const row of rows) {
        const offset = Number(row.y) * CANVAS_WIDTH + Number(row.x);
        pipeline.setrange(dataKey, offset, Buffer.from([Number(row.color)]));
      }
      await pipeline.exec();
      watermark = Number(rows[rows.length - 1].seq);
      if (rows.length < REPLAY_BATCH) break;
    }

    if (watermark === 0) {
      await redis.set(seqKey, '0', 'NX');
      console.log('[init] no snapshot or history, initialized empty canvas at seq 0');
      return;
    }

    await redis.set(seqKey, String(watermark));
    console.log(
      `[init] restored canvas at seq ${watermark} (snapshot=${snapshot ? snapshot.seq : 'none'})`,
    );
  } finally {
    await Promise.allSettled([redis.quit(), pool.end()]);
  }
}

main().catch((error) => {
  console.error('[init] fatal', error);
  process.exit(1);
});
