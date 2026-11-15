import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { config } from './config.js';
import { CONFIG_CHANNEL, keys } from './constants.js';
import { SESSION_COOKIE, parseCookies, signSession, verifySession } from './auth.js';
import {
  ApiError,
  badColor,
  badRequest,
  cooldown,
  forbidden,
  outOfBounds,
  unavailable,
  unauthenticated,
} from './errors.js';
import {
  MAX_CANVAS_SIZE,
  MAX_PALETTE_SIZE,
  MIN_CANVAS_SIZE,
  normalizePalette,
  resetCanvas,
  saveConfigToDb,
  storeCanvasConfig,
  type CanvasConfig,
  type CanvasState,
} from './canvas-config.js';
import { Breaker } from './breaker.js';
import { placePixel } from './placement.js';
import { DeltasGoneError, getDeltas, getSeq, getSnapshot } from './snapshot.js';
import { publishEvent } from './events.js';
import {
  canvasSeq,
  deltaCatchup,
  idempotencyReplay,
  pixelsPlaced,
  placementDuration,
  rateLimitRejected,
  registry,
} from './metrics.js';
import { isRecord } from './guards.js';

export interface AppDeps {
  redis: Redis;
  pool: pg.Pool;
  state: CanvasState;
}

type AsyncHandler = (req: Request, res: Response) => Promise<unknown>;

const asyncRoute =
  (fn: AsyncHandler) => (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const userId = verifySession(token, config.authSecret);
  if (!userId) {
    next(unauthenticated());
    return;
  }
  res.locals.userId = userId;
  next();
};

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  const redisBreaker = new Breaker('redis');

  const isAdminUser = async (userId: number): Promise<boolean> => {
    const { rows } = await deps.pool.query<{ username: string }>(
      'SELECT username FROM users WHERE id = $1',
      [userId],
    );
    return rows[0]?.username === config.adminUsername;
  };

  const requireAdmin = async (res: Response): Promise<void> => {
    const userId = Number(res.locals.userId);
    if (!Number.isInteger(userId) || !(await isAdminUser(userId))) throw forbidden();
  };

  app.disable('x-powered-by');
  app.use(express.json({ limit: '4kb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.get(
    '/readyz',
    asyncRoute(async (_req, res) => {
      const [pong, seqExists] = await Promise.all([
        deps.redis.ping(),
        deps.redis.exists(keys.seq(config.canvasId)),
      ]);
      const ready = pong === 'PONG' && seqExists === 1;
      res.status(ready ? 200 : 503).json({ ready });
    }),
  );

  app.get('/metrics', asyncRoute(async (_req, res) => {
    res.set('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  }));

  app.get(
    '/api/canvas/meta',
    asyncRoute(async (_req, res) => {
      const seq = await getSeq(deps.redis, config.canvasId);
      canvasSeq.set(seq);
      const canvas = deps.state.config;
      res.json({
        width: canvas.width,
        height: canvas.height,
        seq,
        cooldown_seconds: config.cooldownSeconds,
        palette: canvas.palette,
        server_time: Date.now(),
      });
    }),
  );

  app.get(
    '/api/canvas/snapshot',
    asyncRoute(async (req, res) => {
      const canvas = deps.state.config;
      const snapshot = await getSnapshot(
        deps.redis,
        config.canvasId,
        canvas.width,
        canvas.height,
      );
      canvasSeq.set(snapshot.seq);
      const etag = `"v1-${snapshot.seq}"`;
      res.set({
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'public, max-age=5, stale-while-revalidate=10',
        ETag: etag,
        'X-Canvas-Seq': String(snapshot.seq),
      });
      if (req.headers['if-none-match'] === etag) {
        res.status(304).end();
        return;
      }
      res.send(snapshot.buffer);
    }),
  );

  app.get(
    '/api/canvas/deltas',
    asyncRoute(async (req, res) => {
      const sinceRaw = req.query.since;
      if (typeof sinceRaw !== 'string' || !/^\d+$/.test(sinceRaw)) {
        throw badRequest('since 必须是正整数');
      }
      const since = Number(sinceRaw);
      if (!Number.isSafeInteger(since)) throw badRequest('since 必须是正整数');

      try {
        const result = await getDeltas(deps.redis, config.canvasId, since);
        deltaCatchup.inc({ result: 'ok' });
        res.json(result);
      } catch (error) {
        if (error instanceof DeltasGoneError) {
          deltaCatchup.inc({ result: 'gone' });
          throw new ApiError(410, 'gone', '增量已不可回放，请重新拉取快照');
        }
        if (error instanceof RangeError) {
          throw badRequest('since 大于当前水位');
        }
        throw error;
      }
    }),
  );

  app.post(
    '/api/pixels',
    authMiddleware,
    asyncRoute(async (req, res) => {
      const stopTimer = placementDuration.startTimer();
      try {
        const userId = Number(res.locals.userId);
        if (!Number.isInteger(userId)) throw unauthenticated();
        const body: unknown = req.body;
        if (!isRecord(body)) throw badRequest('请求体必须是 JSON 对象');

        const x = body.x;
        const y = body.y;
        const color = body.color;
        const requestId = body.request_id;
        if (
          typeof x !== 'number' || !Number.isInteger(x) ||
          typeof y !== 'number' || !Number.isInteger(y) ||
          typeof color !== 'number' || !Number.isInteger(color) ||
          typeof requestId !== 'string' ||
          !/^[A-Za-z0-9_-]{8,128}$/.test(requestId)
        ) {
          throw badRequest('x/y/color 必须为整数，request_id 必须是 8–128 位安全字符');
        }

        const canvas = deps.state.config;
        if (x < 0 || x >= canvas.width || y < 0 || y >= canvas.height) {
          throw outOfBounds();
        }
        if (color < 0 || color >= canvas.palette.length) {
          throw badColor(canvas.palette.length);
        }

        let result;
        const nowMs = Date.now();
        try {
          result = await redisBreaker.call(() =>
            placePixel(deps.redis, {
              canvasId: config.canvasId,
              userId,
              offset: y * canvas.width + x,
              color,
              requestId,
              cooldownSeconds: config.cooldownSeconds,
              maxOffset: canvas.width * canvas.height,
              maxColor: canvas.palette.length,
              nowMs,
            }),
          );
        } catch {
          throw unavailable();
        }

        if (result.kind === 'cooldown') {
          rateLimitRejected.inc();
          throw cooldown(result.ttl);
        }
        if (result.kind === 'invalid') {
          throw outOfBounds();
        }
        if (result.kind === 'invalid_color') {
          throw badColor(canvas.palette.length);
        }
        if (result.kind === 'replay') {
          idempotencyReplay.inc();
          res.set('Idempotency-Replayed', 'true').json(JSON.parse(result.body));
          return;
        }

        pixelsPlaced.inc({ color: String(color) });
        canvasSeq.set(result.seq);
        void publishEvent({
          seq: result.seq,
          user_id: userId,
          x,
          y,
          color,
          placed_at: Date.now(),
          request_id: requestId,
        });
        res.json({
          seq: result.seq,
          next_placement_at: nowMs + result.ttl * 1000,
        });
      } finally {
        stopTimer();
      }
    }),
  );

  app.get(
    '/api/me',
    authMiddleware,
    asyncRoute(async (_req, res) => {
      const userId = Number(res.locals.userId);
      const { rows } = await deps.pool.query<{ username: string }>(
        'SELECT username FROM users WHERE id = $1',
        [userId],
      );
      const username = rows[0]?.username ?? null;
      res.json({ user_id: userId, username, is_admin: username === config.adminUsername });
    }),
  );

  app.post(
    '/api/dev/login',
    asyncRoute(async (req, res) => {
      const body: unknown = req.body;
      const username =
        isRecord(body) && typeof body.username === 'string' ? body.username.trim() : '';
      if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) {
        throw badRequest('username 必须是 3–32 位字母、数字或下划线');
      }
      const { rows } = await deps.pool.query<{ id: string; username: string }>(
        `INSERT INTO users (username) VALUES ($1)
         ON CONFLICT (username) DO UPDATE SET username = EXCLUDED.username
         RETURNING id, username`,
        [username],
      );
      const userId = Number(rows[0].id);
      const token = signSession(userId, config.sessionTtlSeconds, config.authSecret);
      res.setHeader(
        'Set-Cookie',
        `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${config.sessionTtlSeconds}`,
      );
      res.json({
        user_id: userId,
        username: rows[0].username,
        is_admin: rows[0].username === config.adminUsername,
      });
    }),
  );

  app.get(
    '/api/admin/canvas',
    authMiddleware,
    asyncRoute(async (_req, res) => {
      await requireAdmin(res);
      res.json({
        ...deps.state.config,
        seq: await getSeq(deps.redis, config.canvasId),
      });
    }),
  );

  app.put(
    '/api/admin/canvas',
    authMiddleware,
    asyncRoute(async (req, res) => {
      await requireAdmin(res);
      const body: unknown = req.body;
      if (!isRecord(body)) throw badRequest('请求体必须是 JSON 对象');

      const width = body.width;
      const height = body.height;
      if (
        typeof width !== 'number' || !Number.isInteger(width) ||
        typeof height !== 'number' || !Number.isInteger(height) ||
        width < MIN_CANVAS_SIZE || width > MAX_CANVAS_SIZE ||
        height < MIN_CANVAS_SIZE || height > MAX_CANVAS_SIZE
      ) {
        throw badRequest(`画布宽高必须是 ${MIN_CANVAS_SIZE}–${MAX_CANVAS_SIZE} 的整数`);
      }
      const palette = normalizePalette(body.palette);
      if (!palette) {
        throw badRequest(`palette 必须是 1–${MAX_PALETTE_SIZE} 个 #RRGGBB 颜色`);
      }

      const current = deps.state.config;
      const resized = width !== current.width || height !== current.height;
      const next: CanvasConfig = {
        width,
        height,
        palette,
        epochSeq: current.epochSeq,
      };

      if (resized) {
        next.epochSeq = await resetCanvas(deps.redis, config.canvasId, width * height);
      }

      await storeCanvasConfig(deps.redis, config.canvasId, next);
      deps.state.config = next;
      await deps.redis.publish(CONFIG_CHANNEL, JSON.stringify(next));
      await saveConfigToDb(deps.pool, config.canvasId, next);

      res.json({ ...next, seq: await getSeq(deps.redis, config.canvasId) });
    }),
  );

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: '接口不存在' } });
  });

  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error instanceof ApiError) {
      const payload: { code: string; message: string; retry_after_ms?: number } = {
        code: error.code,
        message: error.message,
      };
      if (error.retryAfterMs !== undefined) {
        payload.retry_after_ms = error.retryAfterMs;
        res.set('Retry-After', String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))));
      }
      res.status(error.status).json({ error: payload });
      return;
    }
    const bodyErrorType =
      typeof error === 'object' && error !== null && 'type' in error && typeof error.type === 'string'
        ? error.type
        : '';
    if (bodyErrorType === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'bad_request', message: 'JSON 解析失败' } });
      return;
    }
    if (bodyErrorType === 'entity.too.large') {
      res.status(413).json({ error: { code: 'bad_request', message: '请求体过大' } });
      return;
    }
    console.error('[api] unhandled error', error);
    res.status(500).json({ error: { code: 'internal', message: '服务器内部错误' } });
  });

  return app;
}
