import promClient from 'prom-client';

const { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } = promClient;

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const placementDuration = new Histogram({
  name: 'rplace_pixel_placement_duration_seconds',
  help: '热路径像素放置耗时',
  buckets: [0.001, 0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5],
  registers: [registry],
});

export const pixelsPlaced = new Counter({
  name: 'rplace_pixels_placed_total',
  help: '成功放置的像素数',
  labelNames: ['color'],
  registers: [registry],
});

export const canvasSeq = new Gauge({
  name: 'rplace_canvas_seq',
  help: '画布当前写入序号',
  registers: [registry],
});

export const activeConnections = new Gauge({
  name: 'rplace_active_websocket_connections',
  help: '当前 WebSocket 连接数',
  registers: [registry],
});

export const broadcastBatchSize = new Histogram({
  name: 'rplace_ws_broadcast_batch_size',
  help: '每次合批的像素数',
  buckets: [1, 4, 16, 64, 128, 256, 512],
  registers: [registry],
});

export const slowConsumerDisconnects = new Counter({
  name: 'rplace_ws_slow_consumer_disconnects_total',
  help: '因发送队列超限被断开的连接数',
  registers: [registry],
});

export const rateLimitRejected = new Counter({
  name: 'rplace_rate_limit_rejected_total',
  help: '因冷却被拒绝的放置请求数',
  registers: [registry],
});

export const idempotencyReplay = new Counter({
  name: 'rplace_idempotency_replay_total',
  help: '幂等重放次数',
  registers: [registry],
});

export const deltaCatchup = new Counter({
  name: 'rplace_delta_catchup_total',
  help: '增量追平请求数',
  labelNames: ['result'],
  registers: [registry],
});

export const persistenceQueueDepth = new Gauge({
  name: 'rplace_persistence_queue_depth',
  help: '持久化队列积压消息数',
  registers: [registry],
});

export const persistenceDropped = new Counter({
  name: 'rplace_persistence_dropped_total',
  help: '未能入队且未 spool 的持久化事件数',
  registers: [registry],
});

export const persistenceSpooled = new Counter({
  name: 'rplace_persistence_spooled_total',
  help: '降级写入本地 spool 的事件数',
  registers: [registry],
});
