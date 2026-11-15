import { isRecord } from './guards';

export const WIDTH = 1000;
export const HEIGHT = 1000;

export const PALETTE = [
  '#FFFFFF',
  '#E4E4E4',
  '#888888',
  '#222222',
  '#FFA7D1',
  '#E50000',
  '#E59500',
  '#A06A42',
  '#E5D900',
  '#94E044',
  '#02BE01',
  '#00D3DD',
  '#0083C7',
  '#0000EA',
  '#CF6EE4',
  '#820080',
] as const;

export const PALETTE_RGB: ReadonlyArray<readonly [number, number, number]> = PALETTE.map(
  (hex) => {
    const value = Number.parseInt(hex.slice(1), 16);
    return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff] as const;
  },
);

export const SNAPSHOT_HEADER_BYTES = 20;

export interface SnapshotData {
  pixels: Uint8Array;
  seq: number;
  width: number;
  height: number;
}

export async function fetchSnapshot(noStore = false): Promise<SnapshotData> {
  const res = await fetch('/api/canvas/snapshot', noStore ? { cache: 'no-store' } : undefined);
  if (!res.ok) throw new Error(`snapshot HTTP ${res.status}`);
  const raw = new Uint8Array(await res.arrayBuffer());
  if (raw.length < SNAPSHOT_HEADER_BYTES) throw new Error('snapshot too short');

  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const magic = String.fromCharCode(raw[0], raw[1], raw[2], raw[3]);
  const version = view.getUint16(4, true);
  const width = view.getUint16(6, true);
  const height = view.getUint16(8, true);
  const seq = Number(view.getBigUint64(12, true));

  if (magic !== 'RPLC') throw new Error('snapshot magic mismatch');
  if (version !== 1) throw new Error(`snapshot version ${version} unsupported`);
  if (width !== WIDTH || height !== HEIGHT) {
    throw new Error(`snapshot size ${width}x${height} unsupported`);
  }
  if (raw.length < SNAPSHOT_HEADER_BYTES + width * height) {
    throw new Error('snapshot payload truncated');
  }

  return {
    pixels: raw.slice(SNAPSHOT_HEADER_BYTES, SNAPSHOT_HEADER_BYTES + width * height),
    seq,
    width,
    height,
  };
}

export interface Delta {
  s: number;
  i: number;
  c: number;
}

export async function fetchDeltas(
  since: number,
): Promise<{ to: number; d: Delta[] } | null> {
  const res = await fetch(`/api/canvas/deltas?since=${since}`);
  if (res.status === 410) return null;
  if (!res.ok) throw new Error(`deltas HTTP ${res.status}`);

  const body: unknown = await res.json();
  if (!isRecord(body) || !Array.isArray(body.d)) throw new Error('deltas malformed');

  const d: Delta[] = [];
  for (const entry of body.d) {
    if (!isRecord(entry)) continue;
    const { s, i, c } = entry;
    if (typeof s !== 'number' || typeof i !== 'number' || typeof c !== 'number') continue;
    d.push({ s, i, c });
  }
  const to = typeof body.to === 'number' ? body.to : since;
  return { to, d };
}

export type ServerFrame =
  | {
      t: 'hello';
      seq: number;
      server_time: number;
      cooldown_ms: number;
      width: number;
      height: number;
    }
  | { t: 'px'; s: number; d: [number, number][] }
  | { t: 'ping'; ts: number }
  | { t: 'resync'; reason?: string }
  | { t: 'bye'; reason?: string };

export function parseFrame(raw: string): ServerFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.t !== 'string') return null;

  if (value.t === 'hello') {
    const { seq, server_time, cooldown_ms, width, height } = value;
    if (
      typeof seq !== 'number' ||
      typeof server_time !== 'number' ||
      typeof cooldown_ms !== 'number' ||
      typeof width !== 'number' ||
      typeof height !== 'number'
    ) {
      return null;
    }
    return { t: 'hello', seq, server_time, cooldown_ms, width, height };
  }

  if (value.t === 'px') {
    if (typeof value.s !== 'number' || !Array.isArray(value.d)) return null;
    const d: [number, number][] = [];
    for (const entry of value.d) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [index, color] = entry;
      if (typeof index !== 'number' || typeof color !== 'number') continue;
      d.push([index, color]);
    }
    return { t: 'px', s: value.s, d };
  }

  if (value.t === 'ping') {
    return { t: 'ping', ts: typeof value.ts === 'number' ? value.ts : 0 };
  }
  if (value.t === 'resync') {
    return { t: 'resync', reason: typeof value.reason === 'string' ? value.reason : undefined };
  }
  if (value.t === 'bye') {
    return { t: 'bye', reason: typeof value.reason === 'string' ? value.reason : undefined };
  }
  return null;
}
