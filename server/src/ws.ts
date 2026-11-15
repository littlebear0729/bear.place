import type { Server } from 'node:http';
import type { Redis } from 'ioredis';
import { WebSocket, WebSocketServer } from 'ws';
import { config } from './config.js';
import {
  CONFIG_CHANNEL,
  UPDATES_CHANNEL,
  WS_FRAME_MAX_PIXELS,
  WS_SEND_QUEUE_LIMIT,
  keys,
} from './constants.js';
import { parseCanvasConfig, type CanvasState } from './canvas-config.js';
import { SESSION_COOKIE, parseCookies, verifySession } from './auth.js';
import { isRecord } from './guards.js';
import { getSeq } from './snapshot.js';
import {
  activeConnections,
  broadcastBatchSize,
  slowConsumerDisconnects,
} from './metrics.js';

export interface WsDeps {
  redis: Redis;
  sub: Redis;
  state: CanvasState;
}

export interface WsController {
  close(): void;
}

interface PixelUpdate {
  s: number;
  i: number;
  c: number;
}

const isPixelUpdate = (value: unknown): value is PixelUpdate => {
  if (typeof value !== 'object' || value === null) return false;
  if (!('s' in value) || !('i' in value) || !('c' in value)) return false;
  return (
    Number.isInteger(value.s) &&
    Number.isInteger(value.i) &&
    Number.isInteger(value.c)
  );
};

export function attachWebSocket(server: Server, deps: WsDeps): WsController {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();
  const pending = new Map<number, PixelUpdate>();
  const userIdBySocket = new WeakMap<WebSocket, number>();
  const alive = new WeakMap<WebSocket, boolean>();
  let subscriberHasBeenReady = false;
  let closed = false;

  const send = (ws: WebSocket, payload: string) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > WS_SEND_QUEUE_LIMIT) {
      slowConsumerDisconnects.inc();
      ws.close(4003, 'slow_consumer');
      return;
    }
    ws.send(payload);
  };

  const broadcast = (message: string) => {
    for (const ws of clients) send(ws, message);
  };

  const flush = () => {
    if (pending.size === 0) return;
    const entries = [...pending.entries()];
    pending.clear();

    for (let start = 0; start < entries.length; start += WS_FRAME_MAX_PIXELS) {
      const chunk = entries.slice(start, start + WS_FRAME_MAX_PIXELS);
      const d: [number, number][] = [];
      let frameSeq = 0;
      for (const [index, update] of chunk) {
        d.push([index, update.c]);
        if (update.s > frameSeq) frameSeq = update.s;
      }
      broadcastBatchSize.observe(chunk.length);
      const payload = JSON.stringify({ t: 'px', s: frameSeq, d });
      for (const ws of clients) send(ws, payload);
    }
  };

  deps.sub.on('message', (channel, raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (channel === CONFIG_CHANNEL) {
      const next = parseCanvasConfig(parsed);
      if (!next) return;
      deps.state.config = next;
      void getSeq(deps.redis, config.canvasId)
        .then((seq) => {
          broadcast(
            JSON.stringify({
              t: 'config',
              width: next.width,
              height: next.height,
              palette: next.palette,
              seq,
            }),
          );
        })
        .catch((error) => console.error('[ws] config broadcast failed', error));
      return;
    }
    if (!isPixelUpdate(parsed)) return;
    const existing = pending.get(parsed.i);
    if (!existing || parsed.s > existing.s) pending.set(parsed.i, parsed);
  });

  deps.sub.on('ready', () => {
    if (subscriberHasBeenReady) {
      broadcast(JSON.stringify({ t: 'resync', reason: 'subscriber_reconnected' }));
    }
    subscriberHasBeenReady = true;
  });

  void deps.sub.subscribe(UPDATES_CHANNEL, CONFIG_CHANNEL).catch((error) => {
    console.error('[ws] subscribe failed', error);
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const origin = req.headers.origin;
    if (origin && !config.allowedOrigins.includes(origin)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const userId = verifySession(
      parseCookies(req.headers.cookie)[SESSION_COOKIE],
      config.authSecret,
    );
    if (!userId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      userIdBySocket.set(ws, userId);
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    const userId = userIdBySocket.get(ws);
    if (!userId) {
      ws.close(4001, 'unauthenticated');
      return;
    }
    clients.add(ws);
    activeConnections.inc();
    alive.set(ws, true);
    ws.on('pong', () => {
      alive.set(ws, true);
    });
    ws.on('close', () => {
      clients.delete(ws);
      activeConnections.dec();
    });
    ws.on('error', () => {
      /* 连接级错误在下一次 flush/ping 中清理 */
    });
    ws.on('message', (data) => {
      try {
        const message: unknown = JSON.parse(String(data));
        if (isRecord(message) && message.t === 'pong') alive.set(ws, true);
      } catch {
        /* 忽略非 JSON 客户端帧 */
      }
    });

    void (async () => {
      const [seq, ttl] = await Promise.all([
        getSeq(deps.redis, config.canvasId),
        deps.redis.ttl(keys.ratelimit(userId)),
      ]);
      const canvas = deps.state.config;
      send(
        ws,
        JSON.stringify({
          t: 'hello',
          seq,
          server_time: Date.now(),
          cooldown_ms: ttl > 0 ? ttl * 1000 : 0,
          width: canvas.width,
          height: canvas.height,
          palette: canvas.palette,
        }),
      );
    })().catch(() => ws.close(1011, 'hello_failed'));
  });

  const batchTimer = setInterval(flush, config.broadcastBatchMs);
  const pingTimer = setInterval(() => {
    for (const ws of clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      send(ws, JSON.stringify({ t: 'ping', ts: Date.now() }));
    }
  }, 25_000);

  return {
    close() {
      if (closed) return;
      closed = true;
      clearInterval(batchTimer);
      clearInterval(pingTimer);
      for (const ws of clients) ws.close(4004, 'server_restart');
      wss.close();
    },
  };
}
