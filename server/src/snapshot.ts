import type { Redis } from 'ioredis';
import {
  DELTA_MAX_ENTRIES,
  SNAPSHOT_HEADER_BYTES,
  SNAPSHOT_MAGIC,
  SNAPSHOT_VERSION,
  keys,
} from './constants.js';

export interface CanvasSnapshot {
  buffer: Buffer;
  seq: number;
}

export function encodeSnapshot(
  data: Buffer,
  seq: number,
  width: number,
  height: number,
): Buffer {
  const pixelCount = width * height;
  const out = Buffer.alloc(SNAPSHOT_HEADER_BYTES + pixelCount);
  out.write(SNAPSHOT_MAGIC, 0, 'ascii');
  out.writeUInt16LE(SNAPSHOT_VERSION, 4);
  out.writeUInt16LE(width, 6);
  out.writeUInt16LE(height, 8);
  out.writeUInt16LE(0, 10);
  out.writeBigUInt64LE(BigInt(seq), 12);
  if (data.length > 0) {
    data.copy(out, SNAPSHOT_HEADER_BYTES, 0, Math.min(data.length, pixelCount));
  }
  return out;
}

async function readCanvas(
  redis: Redis,
  canvasId: string,
  width: number,
  height: number,
): Promise<CanvasSnapshot> {
  // 先读位图再读 seq：即使中间有写入，seq 只会更大，水位比较仍然安全。
  const reply = await redis
    .pipeline()
    .getBuffer(keys.data(canvasId))
    .get(keys.seq(canvasId))
    .exec();
  if (!reply) throw new Error('redis_pipeline_empty');
  const [dataErr, data] = reply[0] ?? [];
  const [seqErr, seqRaw] = reply[1] ?? [];
  if (dataErr) throw dataErr;
  if (seqErr) throw seqErr;
  const seq = seqRaw ? Number(seqRaw) : 0;
  return {
    buffer: encodeSnapshot((data as Buffer | null) ?? Buffer.alloc(0), seq, width, height),
    seq,
  };
}

export async function getSnapshot(
  redis: Redis,
  canvasId: string,
  width: number,
  height: number,
): Promise<CanvasSnapshot> {
  return readCanvas(redis, canvasId, width, height);
}

export async function getSeq(redis: Redis, canvasId: string): Promise<number> {
  const raw = await redis.get(keys.seq(canvasId));
  return raw ? Number(raw) : 0;
}

export interface DeltaEntry {
  s: number;
  i: number;
  c: number;
}

export class DeltasGoneError extends Error {}

export async function getDeltas(
  redis: Redis,
  canvasId: string,
  since: number,
): Promise<{ from: number; to: number; d: DeltaEntry[] }> {
  const seq = await getSeq(redis, canvasId);
  if (since > seq) {
    throw new RangeError('since_ahead_of_seq');
  }
  if (since === seq) {
    return { from: since, to: since, d: [] };
  }

  const rows = (await redis.xrange(
    keys.stream(canvasId),
    `(${since}-0`,
    '+',
    'COUNT',
    DELTA_MAX_ENTRIES + 1,
  )) as [string, string[]][];

  if (rows.length === 0) {
    // 有写入但没有可回放记录：Stream 被截断或刚从快照恢复。
    throw new DeltasGoneError('stream_empty');
  }
  if (rows.length > DELTA_MAX_ENTRIES) {
    throw new DeltasGoneError('too_many_entries');
  }

  const entries: DeltaEntry[] = rows.map(([, fields]) => {
    const map = new Map<string, string>();
    for (let i = 0; i + 1 < fields.length; i += 2) map.set(fields[i], fields[i + 1]);
    return {
      s: Number(map.get('s')),
      i: Number(map.get('i')),
      c: Number(map.get('c')),
    };
  });

  const first = entries[0].s;
  if (first > since + 1) {
    throw new DeltasGoneError('stream_gap');
  }

  return { from: since, to: entries[entries.length - 1].s, d: entries };
}
