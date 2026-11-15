export const CANVAS_WIDTH = 1000;
export const CANVAS_HEIGHT = 1000;
export const PIXEL_COUNT = CANVAS_WIDTH * CANVAS_HEIGHT;

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

export const SNAPSHOT_MAGIC = 'RPLC';
export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_HEADER_BYTES = 20;

export const UPDATES_CHANNEL = 'canvas:updates';
export const STREAM_MAX_LEN = 200_000;
export const DELTA_MAX_ENTRIES = 50_000;
export const WS_FRAME_MAX_PIXELS = 512;
export const WS_SEND_QUEUE_LIMIT = 256 * 1024;

export const keys = {
  data: (canvasId: string) => `canvas:{${canvasId}}:data`,
  seq: (canvasId: string) => `canvas:{${canvasId}}:seq`,
  stream: (canvasId: string) => `canvas:{${canvasId}}:stream`,
  ratelimit: (userId: number) => `ratelimit:${userId}`,
  idempotency: (userId: number, requestId: string) =>
    `idempotency:pixel:${userId}:${requestId}`,
};
