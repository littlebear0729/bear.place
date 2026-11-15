import type { Redis } from 'ioredis';
import type pg from 'pg';
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  PALETTE,
  keys,
} from './constants.js';

export interface CanvasConfig {
  width: number;
  height: number;
  palette: string[];
  epochSeq: number;
}

export interface CanvasState {
  config: CanvasConfig;
}

export const MIN_CANVAS_SIZE = 16;
export const MAX_CANVAS_SIZE = 4096;
export const MAX_PALETTE_SIZE = 256;

export const DEFAULT_CANVAS_CONFIG: CanvasConfig = {
  width: CANVAS_WIDTH,
  height: CANVAS_HEIGHT,
  palette: [...PALETTE],
  epochSeq: 0,
};

export function createCanvasState(config: CanvasConfig): CanvasState {
  return { config };
}

export function normalizePalette(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PALETTE_SIZE) {
    return null;
  }
  const palette: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(entry)) return null;
    palette.push(entry.toUpperCase());
  }
  return palette;
}

export function parseCanvasConfig(value: unknown): CanvasConfig | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const width = raw.width;
  const height = raw.height;
  if (
    typeof width !== 'number' || !Number.isInteger(width) ||
    width < MIN_CANVAS_SIZE || width > MAX_CANVAS_SIZE ||
    typeof height !== 'number' || !Number.isInteger(height) ||
    height < MIN_CANVAS_SIZE || height > MAX_CANVAS_SIZE
  ) {
    return null;
  }
  const palette = normalizePalette(raw.palette);
  if (!palette) return null;
  const epochSeqRaw = raw.epochSeq ?? raw.epoch_seq ?? 0;
  const epochSeq = typeof epochSeqRaw === 'number' ? epochSeqRaw : Number(epochSeqRaw);
  if (!Number.isSafeInteger(epochSeq) || epochSeq < 0) return null;
  return { width, height, palette, epochSeq };
}

export async function ensureSchema(pool: pg.Pool): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS canvas_settings (
       canvas_id   TEXT PRIMARY KEY,
       width       INTEGER NOT NULL CHECK (width BETWEEN 16 AND 4096),
       height      INTEGER NOT NULL CHECK (height BETWEEN 16 AND 4096),
       palette     JSONB   NOT NULL,
       epoch_seq   BIGINT  NOT NULL DEFAULT 0,
       updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  // 旧版 schema 把尺寸与颜色数量写死在 CHECK 里，运行时配置需要放宽。
  await pool.query(
    'ALTER TABLE canvas_snapshots DROP CONSTRAINT IF EXISTS canvas_snapshots_canvas_data_check',
  );
  await pool.query(
    'ALTER TABLE pixel_events DROP CONSTRAINT IF EXISTS pixel_events_color_check',
  );
  await pool.query(
    `DO $$
     BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_constraint WHERE conname = 'pixel_events_color_range'
       ) THEN
         ALTER TABLE pixel_events
           ADD CONSTRAINT pixel_events_color_range CHECK (color BETWEEN 0 AND 255);
       END IF;
     EXCEPTION WHEN duplicate_object THEN NULL;
     END $$`,
  );
}

export async function loadConfigFromDb(
  pool: pg.Pool,
  canvasId: string,
): Promise<CanvasConfig> {
  const { rows } = await pool.query<{
    width: number;
    height: number;
    palette: unknown;
    epoch_seq: string;
  }>(
    `SELECT width, height, palette, epoch_seq
       FROM canvas_settings
      WHERE canvas_id = $1`,
    [canvasId],
  );
  const row = rows[0];
  if (!row) return { ...DEFAULT_CANVAS_CONFIG, palette: [...DEFAULT_CANVAS_CONFIG.palette] };
  const config = parseCanvasConfig({
    width: row.width,
    height: row.height,
    palette: row.palette,
    epochSeq: Number(row.epoch_seq),
  });
  return config ?? { ...DEFAULT_CANVAS_CONFIG, palette: [...DEFAULT_CANVAS_CONFIG.palette] };
}

export async function saveConfigToDb(
  pool: pg.Pool,
  canvasId: string,
  config: CanvasConfig,
): Promise<void> {
  await pool.query(
    `INSERT INTO canvas_settings (canvas_id, width, height, palette, epoch_seq, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, now())
     ON CONFLICT (canvas_id) DO UPDATE
       SET width = EXCLUDED.width,
           height = EXCLUDED.height,
           palette = EXCLUDED.palette,
           epoch_seq = EXCLUDED.epoch_seq,
           updated_at = now()`,
    [
      canvasId,
      config.width,
      config.height,
      JSON.stringify(config.palette),
      config.epochSeq,
    ],
  );
}

export async function loadCanvasConfig(
  redis: Redis,
  pool: pg.Pool,
  canvasId: string,
): Promise<CanvasConfig> {
  const raw = await redis.get(keys.config(canvasId));
  if (raw) {
    try {
      const parsed = parseCanvasConfig(JSON.parse(raw));
      if (parsed) return parsed;
    } catch {
      /* 损坏的缓存回落到数据库 */
    }
  }
  const config = await loadConfigFromDb(pool, canvasId);
  await redis.set(keys.config(canvasId), JSON.stringify(config));
  return config;
}

export async function storeCanvasConfig(
  redis: Redis,
  canvasId: string,
  config: CanvasConfig,
): Promise<void> {
  await redis.set(keys.config(canvasId), JSON.stringify(config));
}

const RESIZE_SCRIPT = `
local len = tonumber(ARGV[1])
redis.call('SET', KEYS[1], string.rep(string.char(0), len))
local seq = redis.call('INCR', KEYS[2])
redis.call('DEL', KEYS[3])
return seq
`;

export async function resetCanvas(
  redis: Redis,
  canvasId: string,
  length: number,
): Promise<number> {
  const seq = await redis.eval(
    RESIZE_SCRIPT,
    3,
    keys.data(canvasId),
    keys.seq(canvasId),
    keys.stream(canvasId),
    String(length),
  );
  return Number(seq);
}
