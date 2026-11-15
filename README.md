# r/place

高并发实时协作画布。设计文档见 [DESIGN.md](DESIGN.md)。

```
server/   Node.js 22 + TypeScript（API、WebSocket 扇出、持久化 Worker、冷启动）
web/      React + Vite + Canvas（快照/增量/水位、乐观更新、冷却）
init.sql  PostgreSQL schema
docker-compose.yml  中间件 + 全栈编排
```

## 快速启动

```bash
cp .env.example .env

docker compose up -d                        # 只起 Redis / PostgreSQL / RabbitMQ
docker compose --profile app up -d --build  # 全栈，http://localhost:8080
```

全栈启动顺序由健康检查与 `canvas-init` 保证：中间件 healthy → `canvas-init` 回填画布 →
`api` 通过 `/readyz` 后才接流量 → `web`（Nginx，静态资源 + `/api`、`/ws` 反代）对外。

## 本地开发

```bash
docker compose up -d                        # 中间件

cd server
npm install
npm run build
node dist/init-canvas.js                    # 首次运行：装载快照/回放事件
node dist/api.js                            # :3000
node dist/worker.js                         # 持久化 + 快照

cd web
npm install
npm run dev                                 # :5173，已代理 /api 与 /ws 到 :3000
```

环境变量见 `.env.example` 与 `server/src/config.ts`；本地默认值指向 `127.0.0.1`。

## 接口

契约以 DESIGN.md §4.3 为准，实现对应关系：

| 端点 | 说明 |
|---|---|
| `GET /api/canvas/meta` | 尺寸、调色板、当前 seq、冷却秒数、服务器时间 |
| `GET /api/canvas/snapshot` | 20 字节头 + 1000000 字节位图，`ETag: "v1-<seq>"` |
| `GET /api/canvas/deltas?since=` | Stream 追平，截断时返回 410 |
| `POST /api/pixels` | 放置；`request_id` 幂等；429 带 `retry_after_ms` |
| `POST /api/dev/login` | 开发期登录，签发 HMAC cookie |
| `GET /api/me` | 当前会话 |
| `GET /ws` | `hello` / `px` / `ping` / `resync`，100ms 合批 |
| `GET /healthz`、`GET /readyz`、`GET /metrics` | 存活、就绪、Prometheus |

## 已验证的行为

- 放置成功 / 冷却 429 / 越界与非法颜色 422 / 未登录 401；
- 同一 `request_id` 重放返回**完全相同**的响应体且只写一次画布与一行历史；
- 另一用户的放置经 Redis Pub/Sub → WS 合批在浏览器内实时出现；
- 快照头 `RPLC`/v1/1000×1000/seq，ETag 命中返回 304；
- Stream 被截断时 `/deltas` 返回 410，客户端回退全量快照；
- RabbitMQ 停机时放置仍返回 200，事件落盘 spool，Broker 恢复后 Worker 补写；
- Redis `FLUSHALL` 后 `init-canvas` 用快照 + `pixel_events` 回放恢复，水位取 `max(快照seq, 事件seq)`，不回退也不撞唯一索引。

## 运维要点

- Redis 必须 `maxmemory-policy noeviction`，画布不允许被淘汰；
- `canvas-init` 是幂等的一次性任务，多副本 API 不会各自回填；
- 慢客户端由 256KB 发送队列上限保护，超限关闭码 4003，重连后经 `/deltas` 追平；
- 指标名 `rplace_*` 见 DESIGN.md §11。
