# r/place 高并发实时协作画布系统 · 设计文档

## 1. 概述与目标

r/place 的核心体验是：一个全局共享的像素画布，任何已登录用户每 5 分钟可以放置一个像素，所有其他用户应在数百毫秒内看到这个像素。

系统的技术难点不在于“画布”本身，而在于：

- **热路径极短**：一次像素放置的完整处理链路必须控制在毫秒级；
- **扇出规模大**：单次写入需要同步到数十万 WebSocket 连接；
- **状态高度集中**：整个画布是一个全局共享对象，读写并发极高；
- **历史持久化不能阻塞实时路径**：审计和时间线回放是刚需，但不能拖慢像素放置。

本设计目标：构建一套 **前后端分离、低延迟、可水平扩展** 的 r/place 类系统，所有中间件通过 **docker-compose** 一键拉起，便于本地开发、集成测试与小规模部署。

---

## 2. 需求

### 2.1 功能需求

| 编号 | 需求 |
|---|---|
| F1 | 共享像素画布，已认证用户可放置彩色像素 |
| F2 | 每用户每 5 分钟只能放置一个像素（可配置） |
| F3 | 其他用户的像素放置应在 500ms 内可见 |
| F4 | 16 色调色板 |
| F5 | 完整像素放置历史，支持审计与时间线回放 |
| F6 | 画布全量快照（新用户首次加载 / 重连恢复） |
| F7 | 放置请求重试幂等：客户端重复提交同一 `request_id` 不重复写入、不重复消耗冷却 |
| F8 | 断线重连后可补回错过的最新增量（不强制全量重拉） |

### 2.2 非功能需求

| 维度 | 目标 |
|---|---|
| 延迟 | 像素放置端到端 P95 ≤ 500ms；热路径写入 P99 ≤ 50ms（实测目标 ≤ 10ms） |
| 并发 | 20 万–50 万 常驻 WebSocket 连接（单实例 1–5 万） |
| 写入 | 峰值约 1,700 像素/秒（50 万连接 / 300s 冷却，最坏情况同时到期）；35,000 RPS 仅作为热路径压测上限 |
| 扇出 | 每客户端 ≤ 10 帧/秒（100ms 合并窗口），全网帧数 ≤ 连接数 × 10 |
| 一致性 | 画布状态最终一致；单像素 Last-Write-Wins；增量带单调序号 |
| 可用性 | 活动期间 99.9%，单节点故障不影响整体服务 |
| 可扩展性 | WebSocket 服务无状态水平扩展；写入路径随实例线性扩展 |

> **容量自洽性**：逐像素广播在 10M 连接下是 $10^{7} \times 3.5\times10^{4} = 3.5\times10^{11}$ 条/秒，不可行，因此不把 10M 连接作为部署目标。合并广播后 50 万连接 × 10 帧/秒 = $5\times10^{6}$ 帧/秒；按 20 个实例、单实例 2.5 万连接规划，单实例约 25 万帧/秒，这是必须压测验证的数字，不达标就降低批次频率或加实例。35,000 RPS 保留为热路径压测目标，用于验证 Lua 原子路径的余量，不代表常态负载。

---

## 3. 总体架构

系统采用 **CDN 快照 + WebSocket 增量叠加 + Redis 热状态 + 消息队列异步持久化** 的混合架构。

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                              客户端（浏览器）                              │
│               React SPA + HTML5 Canvas + WebSocket Client               │
└───────────────┬─────────────────────────────────────────┬───────────────┘
                │ ① 初始画布快照 (GET /canvas/snapshot)      │ ② WebSocket (delta)
                ▼                                         ▼
┌───────────────────────────────┐         ┌───────────────────────────────┐
│        CDN / 反向代理          │         │     WebSocket Server 集群      │
│  (快照缓存，TTL 1–5s，可省略)  │         │ (Node.js, 无状态, 100ms 合并推送)│
└───────────────┬───────────────┘         └───────────────┬───────────────┘
                │                                         │
                │ 快照读取（未命中）                        │ ③ 像素写入
                ▼                                         ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Redis（热状态 + 限流 + Pub/Sub）                 │
│  ┌────────────────┐ ┌──────────────┐ ┌─────────────────────────────┐   │
│  │ Canvas 位图     │ │ 单调序号 seq   │ │ Pub/Sub 频道 canvas:updates  │   │
│  │ + 限流（Lua）   │ │ INCR（同一脚本）│ │ (跨实例广播, 100ms 批次)     │   │
│  └────────────────┘ └──────────────┘ └─────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ Stream canvas:{canvas}:stream（最近 N 条，供重连追平）            │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└───────────────┬─────────────────────────────────────────────────────────┘
                │ ④ API 异步投递像素事件
                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     消息队列（RabbitMQ / Kafka）                         │
│              异步缓冲像素事件，与持久化 Worker 解耦                       │
└───────────────┬─────────────────────────────────────────────────────────┘
                │ ⑤ 消费
                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        持久化 Worker + PostgreSQL                        │
│              像素事件历史表 / 画布快照表（非热路径）                      │
└─────────────────────────────────────────────────────────────────────────┘
```

核心原则：

1. **快照走 CDN / Redis，增量走 WebSocket**：新用户和重连用户通过快照获取完整画布，后续只接收增量像素事件。
2. **画布热状态只存在 Redis 中**：Canvas 以字节数组形式存储，写入是 `SETRANGE` 原子字节操作，无读—改—写，无锁。
3. **持久化完全异步**：像素事件先进入消息队列，由独立 Worker 批量写入 PostgreSQL，主写入路径不等待数据库。
4. **WebSocket 服务无状态**：跨实例广播通过 Redis Pub/Sub 完成，新增实例只需订阅同一频道即可参与扇出。
5. **增量带单调序号**：`INCR canvas:{canvas}:seq` 与 `SETRANGE` 在同一个 Lua 脚本内完成，快照返回 seq 水位；客户端丢弃 `s ≤ 水位` 的增量，避免旧增量覆盖新快照。
6. **批量 + 背压**：每实例 100ms 合并一次增量再推送；单连接发送队列有上限，超限断开慢客户端，由其重连后追平。

---

## 4. 前后端分离设计

### 4.1 前端（React SPA）

| 模块 | 技术选型 | 职责 |
|---|---|---|
| 画布渲染 | HTML5 Canvas API | 全量快照绘制 + 增量像素绘制；支持缩放/平移 |
| 状态管理 | Zustand | 画布本地状态、冷却计时器、连接状态、序号水位 |
| 实时通信 | 原生 WebSocket | 接收 `px` 批量帧；断线指数退避重连 |
| 初始加载 | `GET /api/canvas/snapshot` | 获取当前画布的二进制快照（含 seq 水位） |
| 增量追平 | `GET /api/canvas/deltas?since=<seq>` | 重连/CDN 快照偏旧时补齐缺口，410 则回退全量快照 |
| 像素放置 | `POST /api/pixels`（仅 REST） | 乐观更新 + 服务端校验；`request_id` 保证重试安全 |
| 冷却提示 | 本地计时器 + 服务端返回的 `next_placement_at` | 显示剩余等待时间 |

前端低延迟策略：

- **乐观更新**：用户点击像素后立即在本地 Canvas 上绘制，同时发送请求；若服务端拒绝，则用记录的旧颜色回滚该像素并提示原因。
- **快照 + 增量 + 水位**：首次加载使用快照，之后只处理 WebSocket 增量，不轮询全量画布；所有增量帧带 `s`，客户端丢弃 `s ≤ 本地水位` 的帧。
- **连接握手**：`ws hello` 拿到服务端当前 `seq` → 拉快照（可能来自 CDN，`seq` 偏旧）→ 调 `/deltas?since=<快照 seq>` 补齐到 `hello.seq` → 之后只应用 `s > hello.seq` 的帧。缓冲区在此期间收到的帧，避免任何丢失窗口。
- **WebSocket 优先**：断线指数退避（1s → 30s，带抖动）重连；重连后不强制全量快照，优先 `/deltas` 追平，返回 410 才拉全量。
- **时钟对齐**：`hello` 携带 `server_time`，客户端用它与本地时间差校正冷却倒计时。

### 4.2 后端（WebSocket Server + REST API）

后端可基于 Node.js（Express）同时承载 REST 路由和 WebSocket 升级，也可拆分为独立服务。核心模块：

| 模块 | 职责 |
|---|---|
| `auth` | 用户认证/鉴权，验证 REST 与 WS 握手（cookie + Origin 白名单） |
| `rate-limit` | 基于 Redis 的分布式冷却限流（在放置 Lua 脚本内完成） |
| `canvas` | Redis `SETRANGE` / `MGET`，画布读写与快照序列化 |
| `pubsub` | Redis Pub/Sub 发布与订阅，跨实例广播；100ms 合批与慢客户端背压 |
| `idempotency` | 基于 `userId + request_id` 的幂等键，在放置 Lua 脚本内完成 |
| `persistence-worker` | 独立进程，消费消息队列，批量写入 PostgreSQL |
| `circuit-breaker` | 对 Redis / 消息队列调用做熔断，故障时快速失败而非排队超时 |
| `metrics` | Prometheus 指标暴露（放置延迟、连接数、限流拒绝数等） |

> 后端语言选型说明见附录 A。

### 4.3 接口契约（前后端并行开发基线）

本节是前后端唯一事实来源；实现与测试以此为准。所有时间为 Unix 毫秒（int64）。

错误响应统一为：

```json
{ "error": { "code": "cooldown", "message": "仍在冷却中", "retry_after_ms": 123456 } }
```

#### 4.3.1 画布常量

| 常量 | 值 |
|---|---|
| 画布尺寸 | 默认 1000 × 1000；管理员可在 16–4096 范围内调整（`canvas_settings`，快照头部携带实际尺寸） |
| 颜色索引 | `uint8`；调色板默认 16 色，管理员可调整为 1–256 色 |
| 索引 0 语义 | 背景/空白（`#FFFFFF`）；Redis 零填充后的默认值即为背景 |
| 冷却窗口 | 300s（`COOLDOWN_SECONDS`） |
| 增量合并窗口 | 100ms（`BROADCAST_BATCH_MS`） |
| 幂等 TTL | 10s |
| 追平流保留 | `MAXLEN ~ 200000`（约 2 分钟写入量） |

调色板（索引 → RGB，默认顺序；管理员改色后按新顺序生效，前后端与 DB 共用）：

| # | HEX | # | HEX | # | HEX | # | HEX |
|---|---|---|---|---|---|---|---|
| 0 | #FFFFFF | 4 | #FFA7D1 | 8 | #E5D900 | 12 | #0083C7 |
| 1 | #E4E4E4 | 5 | #E50000 | 9 | #94E044 | 13 | #0000EA |
| 2 | #888888 | 6 | #E59500 | 10 | #02BE01 | 14 | #CF6EE4 |
| 3 | #222222 | 7 | #A06A42 | 11 | #00D3DD | 15 | #820080 |

#### 4.3.2 快照二进制格式

小端序，20 字节头 + `width × height` 字节负载：

| 偏移 | 长度 | 字段 |
|---|---|---|
| 0 | 4 | magic `"RPLC"`（0x52 0x50 0x4C 0x43） |
| 4 | 2 | version = 1 |
| 6 | 2 | width |
| 8 | 2 | height |
| 10 | 2 | flags（保留，置 0） |
| 12 | 8 | seq（u64，画布水位） |
| 20 | w×h | 像素，行优先，`idx = y*width + x` |

1000×1000 画布总长 1,000,020 字节。头部字段全为小端；`version` 不匹配时客户端拒绝渲染并提示刷新。

```http
GET /api/canvas/snapshot
200 OK
Content-Type: application/octet-stream
Cache-Control: public, max-age=5, stale-while-revalidate=10
ETag: "v1-<seq>"
X-Canvas-Seq: <seq>
Content-Length: 1000020
```

服务端按固定顺序读取 `canvas:{canvas}:data` 与 `canvas:{canvas}:seq`（同一 pipeline、先位图后 seq），保证 `seq` 不小于快照内容水位。数据键不存在时返回全零负载。

```http
GET /api/canvas/meta
200 OK {"width":1000,"height":1000,"seq":918273,"cooldown_seconds":300,
        "palette":["#FFFFFF","#E4E4E4",...],"server_time":1763200000000}
```

#### 4.3.3 放置像素

```http
POST /api/pixels
Content-Type: application/json
Cookie: rplace_session=<signed>

{ "x": 123, "y": 45, "color": 5, "request_id": "9f1c...-uuid-v4" }
```

成功：

```json
{ "seq": 918274, "next_placement_at": 1763200000000 }
```

幂等重放（同一 `request_id` 在 10s 内再次到达）：返回原来的 200 体，并带 `Idempotency-Replayed: true`。

| HTTP | code | 语义 | 是否消耗冷却 |
|---|---|---|---|
| 200 | — | 成功 | 是（新放置）/ 否（幂等重放） |
| 400 | `bad_request` | JSON 结构/类型错误、`request_id` 缺失 | 否 |
| 401 | `unauthenticated` | 未登录或会话失效 | 否 |
| 422 | `out_of_bounds` / `bad_color` | 越界或颜色索引非法 | 否 |
| 429 | `cooldown` | 冷却中；`retry_after_ms` = 剩余 TTL，同时带 `Retry-After`（秒） | 否 |
| 503 | `unavailable` | Redis 熔断/不可用；`Retry-After: 1` | 否 |

**只有真正写入画布的那一次请求消耗冷却**：校验失败、Redis 故障、幂等重放都不消耗。

#### 4.3.4 增量追平

```http
GET /api/canvas/deltas?since=918200
200 OK
{ "from": 918200, "to": 918274,
  "d": [ {"s":918201,"i":12345,"c":5}, {"s":918202,"i":12390,"c":9} ] }
```

- `since` 早于 Stream 头部（已被 `MAXLEN` 截断）→ `410 Gone`，客户端改为拉全量快照。
- `since` 缺省或非正整数 → `400 bad_request`。
- `since` 已是最新（无新事件）→ `200 {"from": since, "to": since, "d": []}`，客户端可安全重试。
- 单次最多返回 50,000 条；超过则返回 `410 Gone`（直接全量更便宜）。
- `d` 按 `s` 升序；客户端应用 `i`（绝对索引）与 `c`，同一 `i` 多次出现时后写入者胜。

#### 4.3.4.1 管理员画布设置

以 `ADMIN_USERNAME`（默认 `admin`）登录的会话可读写运行时画布配置。`GET /api/me` 与 `/api/dev/login` 返回 `is_admin`。

```http
GET /api/admin/canvas
200 OK {"width":800,"height":600,"palette":["#FFFFFF",...],"epochSeq":213,"seq":215}

PUT /api/admin/canvas
Content-Type: application/json

{"width":800,"height":600,"palette":["#FFFFFF","#FF0000"]}
200 OK {"width":800,"height":600,"palette":[...],"epochSeq":213,"seq":215}
403 forbidden   非管理员
400 bad_request 宽高不在 16–4096 或颜色不是 1–256 个 #RRGGBB
```

尺寸变化会清空画布并递增 `seq`；仅调色板变化保留像素。成功后服务端通过 Redis Pub/Sub `canvas:config` 广播 `{"t":"config","width","height","palette","seq"}`，客户端重拉快照。

#### 4.3.5 WebSocket

```http
GET /ws  (Upgrade)
Cookie: rplace_session=<signed>
Origin: https://<允许的源>    # 不在白名单 → 升级前返回 401
```

服务端 → 客户端（JSON text frame）：

```json
{"t":"hello","seq":918273,"server_time":1763200000000,"cooldown_ms":248000,
 "width":1000,"height":1000}
{"t":"px","s":918275,"d":[[12345,5],[12390,9]]}
{"t":"ping","ts":1763200000000}
{"t":"resync","reason":"subscriber_reconnected"}
{"t":"bye","reason":"slow_consumer"}
```

| 字段 | 说明 |
|---|---|
| `hello.seq` | 连接建立瞬间的画布水位；客户端据此判断快照是否落后 |
| `px.s` | 本帧最大像素序号（单调递增，帧内按 `d` 顺序应用） |
| `px.d` | `[绝对索引, 颜色]` 数组；服务端已按 100ms 窗口对同一像素去重，保留最终值 |
| `resync` | 服务端检测到自身订阅断连（可能丢增量），要求客户端走 `/deltas` 或全量快照 |

客户端 → 服务端：v1 仅 `{"t":"pong"}`。**放置一律走 REST**，WS 不承载写入，避免两套重试/限流语义。

关闭码：`1000` 正常；`4001` 未认证；`4002` 会话过期；`4003` 慢消费者（发送队列超限）；`4004` 服务端重启。

单帧上限 512 个像素；超过则拆成多帧（`s` 连续递增），保持每帧 ≤ 8KB。

#### 4.3.6 健康检查

- `GET /healthz`：进程存活，恒 200。
- `GET /readyz`：Redis `PING` 成功且 `canvas:{canvas}:seq` 存在；否则 503。消息队列**不参与**就绪判断——它故障时应继续提供放置服务（见 §7.5），由指标而非 readiness 暴露。`web`/负载均衡只把流量发给 ready 实例。

#### 4.3.7 认证（开发期实现）

```http
POST /api/dev/login
Content-Type: application/json

{ "username": "alice" }
```

```http
200 OK
Set-Cookie: rplace_session=<HMAC(userId, exp)>; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400
{"user_id":42,"username":"alice"}
```

- 首次登录自动 `INSERT INTO users (username)`；`userId` 之外的任何用户数据不进入热路径。
- Cookie 是 `base64(userId.exp).hmac_sha256(AUTH_SECRET)`；服务端验签 + 校验过期，不查库，热路径零额外开销。
- 生产替换为 OAuth2 回调后签发**同格式** cookie，前端与 WS 握手无需改动。
- WS 握手复用同一 cookie，并校验 `Origin` 属于 `ALLOWED_ORIGINS`，否则升级前 401（防 CSWSH）。
- 会话过期：REST 401 `unauthenticated`，WS 关闭码 `4002`，前端跳登录。

```http
GET /api/me
200 OK {"user_id":42,"username":"alice"}
401 Unauthorized
```

前端在挂载时调用一次，决定“已登录则直接连 WS”还是“显示登录表单”；只在页面加载时访问数据库，不在热路径。

---

## 5. 核心数据流：像素放置

### 5.1 热路径（同步，必须极快）

```text
客户端 POST /api/pixels  { x, y, color, request_id }
        │
        ▼
① 认证 + 参数类型校验（不触 Redis，越界/非法直接 422）
        │
        ▼
② 单次 Lua 脚本（EVALSHA，1 个 RTT，原子）：
   幂等命中? → 返回缓存结果 {0, body}
   越界?     → 返回 {-2}
   SET ratelimit:<uid> 1 NX EX 300 失败 → 返回 {-1, ttl}
   SETRANGE canvas:{canvas}:data offset colorByte
   seq = INCR canvas:{canvas}:seq
   XADD canvas:{canvas}:stream MAXLEN ~ 200000 ...
   PUBLISH canvas:updates {s:seq, i:offset, c:color, t:ts}
   SET idempotency:pixel:<uid>:<requestId> body EX 10
   返回 {1, seq, ttl}
        │
        ▼
③ 像素事件投递到消息队列（异步，不阻塞响应）
        │
        ▼
④ 返回 200 { seq, next_placement_at }
```

Lua 脚本（`scripts/place.lua`）：

```lua
-- KEYS[1]=canvas:{canvas}:data  KEYS[2]=ratelimit:<uid>
-- KEYS[3]=canvas:{canvas}:seq   KEYS[4]=idempotency:pixel:<uid>:<rid>
-- KEYS[5]=canvas:{canvas}:stream
-- ARGV[1]=offset  ARGV[2]=color 单字节  ARGV[3]=ttl 秒
-- ARGV[4]=maxOffset  ARGV[5]=now_ms
-- 返回 {0,cached} | {-1,ttl} | {-2} | {1,seq,ttl}

local cached = redis.call('GET', KEYS[4])
if cached then return {0, cached} end

local off, maxOff = tonumber(ARGV[1]), tonumber(ARGV[4])
if not off or off < 0 or off >= maxOff then return {-2} end

local ttl = tonumber(ARGV[3])
if not redis.call('SET', KEYS[2], '1', 'NX', 'EX', ttl) then
  return {-1, redis.call('TTL', KEYS[2])}
end

redis.call('SETRANGE', KEYS[1], off, ARGV[2])
local seq = redis.call('INCR', KEYS[3])
redis.call('XADD', KEYS[5], 'MAXLEN', '~', 200000, seq .. '-0',
           's', seq, 'i', off, 'c', string.byte(ARGV[2]))
redis.call('PUBLISH', 'canvas:updates',
           cjson.encode({s = seq, i = off, c = string.byte(ARGV[2]),
                         t = tonumber(ARGV[5])}))

local body = cjson.encode({seq = seq,
                           next_placement_at = tonumber(ARGV[5]) + ttl * 1000})
redis.call('SET', KEYS[4], body, 'EX', 10)
return {1, seq, ttl}
```

| 返回 | HTTP | 说明 |
|---|---|---|
| `{1, seq, ttl}` | 200 | 成功 |
| `{0, cached}` | 200 + `Idempotency-Replayed: true` | 重放，未消耗冷却 |
| `{-1, ttl}` | 429 + `Retry-After` | 冷却中 |
| `{-2}` | 422 | 越界/非法，未消耗冷却 |

关键点：

- 步骤②是**一次** RTT、7 个 O(1) 命令（1 读 + 6 写），P99 实测目标 ≤ 10ms。
- **冷却只在真正写入时消耗**：校验失败、Redis 故障都不会白白烧掉 5 分钟（修正了原设计“先限流后写入”的缺陷）。
- **序号与写入原子**：`SETRANGE`、`INCR`、`PUBLISH` 在同一脚本内，Redis 单线程执行，因此订阅者看到的 `s` 顺序与写入顺序严格一致；客户端可安全地用 `s` 做水位比较。
- **幂等检查与写入同脚本**：没有“检查完、写之前”的竞态窗口，重试不会双重写入，也不会把已成功的请求显示成 429。
- **Lua 出错不回滚**：所有校验放在任何写命令之前；脚本最后一条语句是 `return`，避免半完成状态。
- 步骤③使用 **fire-and-forget** 或异步发布；MQ 抖动不影响用户响应，事件可能丢失，由 §7.5 的降级策略与快照兜底。

### 5.2 异步路径（持久化）

```text
消息队列
   │
   ▼
Persistence Worker
   │  批量消费（例如每 100 条或每 200ms 一批）
   ▼
PostgreSQL
   INSERT INTO pixel_events (seq, user_id, x, y, color, placed_at, request_id)
   VALUES (...), (...) ON CONFLICT DO NOTHING;
   + 周期性快照写入 canvas_snapshots
```

`ON CONFLICT DO NOTHING` 使 MQ 的至少一次投递不会产生重复历史行（`seq` 与 `request_id` 均有唯一索引）。

持久化 Worker 与 WebSocket 服务**独立部署、独立扩缩**，即使 PostgreSQL 写入变慢，也不会反压到像素放置热路径。

---

## 6. 中间件选型与 docker-compose

### 6.1 中间件清单

| 中间件 | 角色 | 选型理由 |
|---|---|---|
| **Redis** | 画布热状态、序号、限流、幂等键、Pub/Sub、追平 Stream | 原子字节操作 + 内存级读写 + 内置 Pub/Sub/Stream，是热路径的唯一合理选择 |
| **RabbitMQ** | 像素事件异步队列 | 轻量、易运维，足以解耦持久化；若需要更高吞吐或事件回放，可替换为 Kafka |
| **PostgreSQL** | 像素事件历史、画布快照、审计 | 强一致持久化，支持时间线查询与快照回溯 |
| **CDN / Nginx（可选）** | 快照缓存 / 反向代理 | 快照可缓存数秒；本地开发由 `web` 容器的 Nginx 兼任 |

> 关于 Kafka vs RabbitMQ：Reddit 生产环境使用 Kafka 做事件流，以实现大规模扇出与持久化解耦。本设计为 docker-compose 轻量化选择 RabbitMQ，架构上保持“消息队列”抽象，替换为 Kafka 只需更换 Producer/Consumer 实现。
>
> 也可以进一步用 **Redis Streams 取代 RabbitMQ**（消费组 + `XACK` + `MAXLEN`），少一个中间件、同时天然支持回放；代价是持久化与追平共用同一条 Redis，`MAXLEN` 截断后的历史仍要由 PostgreSQL 兜底。当前保留 RabbitMQ 作为默认实现，二者可互换。

### 6.2 docker-compose.yml

```yaml
name: rplace

services:
  redis:
    image: redis:7-alpine
    command: >
      redis-server
      --appendonly yes
      --appendfsync everysec
      --maxmemory 2gb
      --maxmemory-policy noeviction
      --save ""
    ports: ["6379:6379"]
    volumes: ["redis_data:/data"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5
    restart: unless-stopped

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: rplace
      POSTGRES_USER: rplace
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-rplace_dev}
    ports: ["5432:5432"]
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./init.sql:/docker-entrypoint-initdb.d/init.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U rplace -d rplace"]
      interval: 5s
      timeout: 3s
      retries: 5
    restart: unless-stopped

  rabbitmq:
    image: rabbitmq:3-management-alpine
    environment:
      RABBITMQ_DEFAULT_USER: ${RABBITMQ_USER:-rplace}
      RABBITMQ_DEFAULT_PASS: ${RABBITMQ_PASSWORD:-rplace_dev}
    ports: ["5672:5672", "15672:15672"]
    volumes: ["rabbitmq_data:/var/lib/rabbitmq"]
    healthcheck:
      test: ["CMD", "rabbitmq-diagnostics", "-q", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  # 一次性任务：把最新快照装载进 Redis，成功后退出。
  canvas-init:
    profiles: ["app"]
    build: ./server
    command: ["node", "dist/init-canvas.js"]
    environment: &server-env
      REDIS_URL: redis://redis:6379
      DATABASE_URL: postgres://rplace:${POSTGRES_PASSWORD:-rplace_dev}@postgres:5432/rplace
      AMQP_URL: amqp://${RABBITMQ_USER:-rplace}:${RABBITMQ_PASSWORD:-rplace_dev}@rabbitmq:5672
      CANVAS_ID: main
      COOLDOWN_SECONDS: "300"
      BROADCAST_BATCH_MS: "100"
      AUTH_SECRET: ${AUTH_SECRET:-dev-only-secret}
    depends_on:
      redis: { condition: service_healthy }
      postgres: { condition: service_healthy }
    restart: "no"

  api:
    profiles: ["app"]
    build: ./server
    command: ["node", "dist/api.js"]
    environment:
      <<: *server-env
      SPOOL_DIR: /var/lib/rplace/spool
      ALLOWED_ORIGINS: ${ALLOWED_ORIGINS:-http://localhost:8080}
    ports: ["3000:3000"]
    volumes: ["spool_data:/var/lib/rplace"]
    depends_on:
      redis: { condition: service_healthy }
      postgres: { condition: service_healthy }
      rabbitmq: { condition: service_healthy }
      canvas-init: { condition: service_completed_successfully }
    healthcheck:
      test: ["CMD", "node", "-e",
             "fetch('http://127.0.0.1:3000/readyz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
      interval: 10s
      timeout: 3s
      retries: 5
    restart: unless-stopped

  worker:
    profiles: ["app"]
    build: ./server
    command: ["node", "dist/worker.js"]
    environment:
      <<: *server-env
      SPOOL_DIR: /var/lib/rplace/spool
    volumes: ["spool_data:/var/lib/rplace"]
    depends_on:
      redis: { condition: service_healthy }
      postgres: { condition: service_healthy }
      rabbitmq: { condition: service_healthy }
    restart: unless-stopped

  # 前端构建产物 + Nginx（静态资源、/api 与 /ws 反代）
  web:
    profiles: ["app"]
    build: ./web
    ports: ["8080:80"]
    depends_on:
      api: { condition: service_healthy }
    restart: unless-stopped

volumes:
  redis_data:
  rabbitmq_data:
  postgres_data:
  spool_data:
```

启动方式：

```bash
docker compose up -d                              # 只起中间件（本地开发后端）
docker compose --profile app up -d --build        # 全栈，浏览器访问 http://localhost:8080
```

要点：

- **`maxmemory-policy noeviction`**：画布绝不能因为内存策略被淘汰；内存不足时宁可写失败（503）也不能静默丢数据。
- **`canvas-init` 先于 api 完成**：解决“谁把快照装载回 Redis”的启动竞态；多副本 API 不会各自回填。
- 多实例压测：`docker compose --profile app up -d --scale api=3` 需去掉 `api` 的固定 `ports`，由 `web` 的 Nginx upstream 轮询（参考配置见 §10.1）。
- 仓库根目录的 `init.sql`（内容见 §8）在数据库首次初始化时执行；`.env.example` 是环境变量清单，复制为 `.env` 后按需修改。

`.env.example`：

```dotenv
POSTGRES_PASSWORD=rplace_dev
RABBITMQ_USER=rplace
RABBITMQ_PASSWORD=rplace_dev
AUTH_SECRET=change-me
ADMIN_USERNAME=admin
COOLDOWN_SECONDS=300
BROADCAST_BATCH_MS=100
ALLOWED_ORIGINS=http://localhost:8080
```

---

## 7. 核心组件详细设计

### 7.1 画布存储：Redis 字节数组

存储格式：画布是一个 `width × height` 的网格，每个像素用一个字节表示颜色索引（0–15）。整个画布存储为 **Redis 单个 String 值** `canvas:{canvas}:data`，总大小约 `width × height` 字节（1000×1000 仅 1MB）。

Key 命名（`{canvas}` 是真实 hash tag，保证多 key 命令同 slot）：

```text
canvas:{canvas}:data        # 位图
canvas:{canvas}:seq         # 单调序号
canvas:{canvas}:stream      # 最近 20 万条增量，供追平
ratelimit:<userId>          # 花括号在旧文档中是占位符，实际 key 不带花括号
idempotency:pixel:<userId>:<requestId>
```

写入：`SETRANGE canvas:{canvas}:data offset colorByte`。一次 **原子字节写入**，无读—改—写、无分布式锁；并发写同一像素时 LWW。**offset 必须在 Lua 内校验**：`SETRANGE` 会把字符串零填充到 `offset+1`，未校验的超大 offset 会让 Redis 直接申请 GB 级内存（单条恶意请求即可打挂热状态）。

读取：同一 pipeline 内先读位图再读 seq。1000×1000 全量读取在 Redis 中通常 < 5ms；但这 1MB 会在单线程 Redis 上占用约 0.5–1ms，因此快照请求应尽量由 CDN 命中，高 QPS 时从只读副本读。

扩展性说明：单 Key 画布无法分片。如果未来画布尺寸显著增大（例如 2000×2000 以上），应改为 **分块存储**（tile-based scheme），每个 tile 一个 Redis Key，写入和快照按 tile 独立操作。当前设计在 1000×1000 量级下保持单 Key 是最简且最快的方案。

### 7.2 限流：Redis 原子冷却

```text
SET ratelimit:<userId> 1 NX EX 300   # 在放置 Lua 脚本内执行
```

- 第一次放置：`SET NX EX` 返回 `OK`，冷却开始，同一个脚本内继续完成写入。
- 5 分钟内再次放置：返回 `nil`，脚本返回 `{-1, TTL}`，直接拒绝并给出精确 `retry_after_ms`。
- 因为限流与写入在**同一个原子脚本**内，两者要么都发生，要么都不发生——不存在“冷却被消耗但像素没画上”的状态。
- 固定窗口与冷却语义一致，key 只在活跃用户期间存在，TTL 到期自动清理。

### 7.3 跨实例广播：Redis Pub/Sub + 合批

每个 WebSocket Server 实例启动时订阅 `canvas:updates`。收到像素事件后写入**本实例**的 100ms 聚合缓冲（同一索引只保留最终颜色），窗口结束时按 512 像素/帧切分并推送给本地连接。

- 扩展性是**线性**的：新增实例只需订阅频道。
- **PUBLISH 在 Lua 内执行**，因此各实例收到的 `s` 顺序与写入顺序一致；但 Pub/Sub 是 **at-most-once**，订阅连接闪断会静默丢消息。
- 订阅连接断开重连后，实例立即向本地所有客户端广播 `{"t":"resync"}`；客户端走 `/deltas?since=<本地水位>` 或全量快照恢复。这样就不需要跨实例的连接路由表。
- **背压**：每连接维护发送队列，上限 256KB（或 200 帧）；超限直接 `4003` 断开。慢客户端重连后追平，绝不阻塞其他连接。
- 为什么不用 Kafka 做实时广播：像素增量是**短暂**的，客户端错过增量后由 Stream 追平或快照恢复，不需要回放全量历史。Kafka/RabbitMQ 仅用于**持久化**。

### 7.4 幂等放置

```text
KEY: idempotency:pixel:<userId>:<requestId>   # requestId 由客户端生成（UUID v4）
值:  成功响应体 {seq, next_placement_at}       TTL: 10s
```

- **顺序**：幂等检查在 Lua 脚本的**第一条**，先于限流与写入。原设计把幂等放在限流之后，导致“重试永远命中 429、缓存结果永不可达”。
- **键的选择**：用客户端 `request_id` 而不是 `{x,y,color}`。内容键会把“10 秒内的新意图”与“重试”混为一谈，也无法区分两个不同用户操作。
- 命中时返回原始 200 体并带 `Idempotency-Replayed: true`，**不写画布、不重置冷却、不投递持久化事件**。
- TTL 10s 覆盖典型重试窗口；远小于 300s 冷却，不影响下一次正常放置。

### 7.5 熔断与降级

对 Redis 和消息队列的调用包裹熔断器（circuit breaker）：

- **Redis 熔断打开时**：放置请求快速失败 503，返回 `Retry-After: 1`。因为限流与写入在同一脚本内，失败不会消耗冷却。关键是**不要**让请求排队等待 Redis 超时，否则少量 Redis 故障会迅速耗尽连接池。
- **消息队列熔断打开时**：像素放置仍然成功返回（画布已更新、Pub/Sub 已广播、Stream 已记录），持久化事件降级写入本地磁盘 spool，待队列恢复后补发。若 spool 也写不进去，则丢弃该事件并递增 `rplace_persistence_dropped_total`；以 PostgreSQL 快照为准，审计缺口在指标与日志中可见。
- **WS 扇出不降级**：Pub/Sub 失败时客户端靠 `resync` + `/deltas` 恢复，不回退轮询。

---

## 8. 快照与持久化

### 8.1 像素事件表（PostgreSQL）

```sql
CREATE TABLE users (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username    TEXT        NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pixel_events (
    id          BIGSERIAL PRIMARY KEY,
    seq         BIGINT      NOT NULL,   -- 与 canvas:{canvas}:seq 一致，回放顺序
    user_id     BIGINT      NOT NULL REFERENCES users(id),
    x           INT         NOT NULL CHECK (x >= 0),
    y           INT         NOT NULL CHECK (y >= 0),
    color       SMALLINT    NOT NULL CHECK (color BETWEEN 0 AND 15),
    placed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    request_id  TEXT        NOT NULL
);

CREATE UNIQUE INDEX idx_events_seq        ON pixel_events (seq);
CREATE UNIQUE INDEX idx_events_request    ON pixel_events (request_id);
CREATE INDEX        idx_events_placed_at  ON pixel_events (placed_at);
CREATE INDEX        idx_events_user       ON pixel_events (user_id, placed_at DESC);
```

`pixel_events` 只追加，不更新。持久化 Worker 批量 INSERT（每 200ms 或每 500 条一批），`ON CONFLICT DO NOTHING` 吸收重复投递。

### 8.2 画布快照与冷启动

Redis 中的位图本身就是完整快照。Persistence Worker 周期性（每 30 秒）执行：

```text
MGET canvas:{canvas}:data canvas:{canvas}:seq
INSERT INTO canvas_snapshots (canvas_id, seq, canvas_data) VALUES (...)
```

```sql
CREATE TABLE canvas_snapshots (
    id          BIGSERIAL PRIMARY KEY,
    canvas_id   TEXT        NOT NULL DEFAULT 'main',
    seq         BIGINT      NOT NULL,
    canvas_data BYTEA       NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_snapshots_latest ON canvas_snapshots (canvas_id, id DESC);

CREATE TABLE canvas_settings (
    canvas_id   TEXT PRIMARY KEY,
    width       INTEGER NOT NULL CHECK (width BETWEEN 16 AND 4096),
    height      INTEGER NOT NULL CHECK (height BETWEEN 16 AND 4096),
    palette     JSONB   NOT NULL,
    epoch_seq   BIGINT  NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- 快照长度随 `canvas_settings` 的尺寸变化，不再固定为 1,000,000 字节。
- 管理员缩容/扩容会把 `canvas:{canvas}:data` 重置为新尺寸的空画布、递增 `seq`、删除追平 Stream，并把新 `seq` 写入 `epoch_seq`；早于纪元的快照与事件在冷启动时被跳过。

- 体积：1MB × 每分钟 2 次 ≈ 2.9GB/天，必须有保留策略。建议**保留最近 24 小时全部 + 更早的每小时 1 张**，由 Worker 每小时清理一次。
- **冷启动流程（`init-canvas` 一次性任务）**：
  1. `EXISTS canvas:{canvas}:seq` 为真 → 直接退出（幂等）；
  2. 否则取 `canvas_snapshots` 最新一行，`SET canvas:{canvas}:data <bytes>`；
  3. 以快照 `seq` 为起点，分批读取 `pixel_events WHERE seq > 快照seq ORDER BY seq`，用 pipeline `SETRANGE` 回放，得到水位 `max(快照seq, 最大事件seq)`；
  4. 无快照时从 `seq=0` 开始回放全部事件，等价于用历史重建画布；
  5. 两者都没有 → `SET canvas:{canvas}:seq 0 NX`，位图留空。
- **序号不能丢，也不能回退**：Redis 丢失 seq 后若从快照水位继续 `INCR`，新事件的序号会与 `pixel_events.seq` 唯一索引冲突，**被 `ON CONFLICT DO NOTHING` 静默丢弃**。因此水位必须取 `max(快照 seq, 事件表最大 seq)`，恢复后第一次写入一定是全新序号。
- 回放同时消除了“快照间隔内像素永久丢失”的窗口；代价是启动时多一次按 `seq` 索引的范围扫描（正常规模为几十条）。
- 从历史重建的规模上限：`pixel_events` 全量回放按 5000 条/批，适合本地与中小部署；超大规模应保留最近快照，只回放快照之后的事件。
- API 实例的 `/readyz` 要求 `seq` 存在，保证不会在回填前接流量。

---

## 9. 低延迟与高并发策略汇总

| 策略 | 实现方式 | 收益 |
|---|---|---|
| 热路径纯内存 | 限流、画布写入、序号、广播全部在 Redis 内完成 | P99 写入延迟 ≤ 50ms（实测 ≤ 10ms） |
| 单 RTT 原子脚本 | `EVALSHA` 一次完成幂等 + 限流 + 写入 + 序号 + 发布 | 4 次 RTT 降为 1 次，无中间失败态 |
| 原子操作免锁 | `SETRANGE` 写画布，`SET NX EX` 限流 | 无分布式锁开销，无竞态 |
| 序号水位 | `INCR` 与写入同脚本，快照带 seq | 快照 + 增量不会错序覆盖 |
| 100ms 合并广播 | 每实例聚合窗口，同像素取最终值，512 像素/帧 | 扇出帧数降 1–2 个数量级 |
| 背压 | 单连接发送队列上限 256KB，超限断开 | 慢客户端不拖垮实例 |
| 异步持久化 | 消息队列 + 独立 Worker | 数据库延迟不阻塞用户 |
| Pub/Sub 线性扇出 | 每个 WS 实例订阅同一频道，本地推送 | 新增实例即可扩容 |
| Stream 追平 | `XADD` + `/deltas?since=`，410 回退全量 | 重连不强制 1MB 快照，CDN 可安全缓存 |
| 恢复回放 | `init` 用快照 + `pixel_events` 回放，水位取 `max` | 冷启动不丢像素，序号不回退 |
| CDN 快照缓存 | `max-age=5, stale-while-revalidate=10` + 追平 | 大幅降低 Redis 快照读取 QPS |
| 幂等去重 | `userId+request_id` 短期键，脚本内检查 | 重试不会双重写入 / 重置冷却 |
| 熔断快速失败 | 对 Redis / MQ 做 circuit breaker | Redis 抖动时不拖垮整个服务 |
| WebSocket 无状态 | 不维护跨实例连接路由 | 水平扩展无状态障碍 |

---

## 10. 部署拓扑与扩展路径

### 10.1 本地 / 小规模（docker-compose）

单机运行 Redis、RabbitMQ、PostgreSQL，`--profile app` 启动 API + Worker + Web；压测时用 `--scale api=3` 多实例，Nginx upstream：

```nginx
upstream api { server api:3000; }
server {
    listen 80;
    location /api/ { proxy_pass http://api; }
    location /ws   {
        proxy_pass http://api;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
    }
    location / { root /usr/share/nginx/html; try_files $uri /index.html; }
}
```

### 10.2 生产水平扩展

```text
负载均衡 (L4/L7, sticky session 可选)
        │
        ├── WebSocket Server × N（无状态，按连接数扩容）
        │
        ├── REST API Server × M（与 WS 可合并或分离）
        │
        ├── Redis（主从 + Sentinel / Cluster）
        │      ├── 画布热状态 + 序号 + Stream（同 slot）
        │      ├── 限流 + 幂等
        │      └── Pub/Sub（可独立实例）
        │
        ├── RabbitMQ / Kafka（按事件吞吐扩容分区/队列）
        │
        └── PostgreSQL（主从，读副本用于历史查询）
                │
                Persistence Worker × K（按消息积压扩容）
```

扩展要点：

- **WebSocket 层**：无状态，新增实例订阅频道即可参与扇出，负载均衡无需连接迁移。
- **Redis**：画布的两个 key 用 `{canvas}` hash tag 固定在同一个 shard（`MGET` 才能工作）；Pub/Sub 在 Cluster 模式下建议独立实例，避免与画布抢占；快照读取走只读副本。
- **持久化层**：MQ 分区数决定并行度；Worker 按分区消费。

---

## 11. 监控与可观测性

关键指标（Prometheus 格式）：

| 指标 | 类型 | 用途 |
|---|---|---|
| `rplace_pixel_placement_duration_seconds` | Histogram | 热路径 P50/P95/P99 延迟 |
| `rplace_pixels_placed_total{color}` | Counter | 放置速率，按颜色分布 |
| `rplace_canvas_seq` | Gauge | 写入进度，用于确认服务是否在前进 |
| `rplace_active_websocket_connections` | Gauge | 当前连接数，扩容依据 |
| `rplace_ws_broadcast_batch_size` | Histogram | 合批效果，异常偏小说明窗口失效 |
| `rplace_ws_slow_consumer_disconnects_total` | Counter | 背压触发次数 |
| `rplace_rate_limit_rejected_total` | Counter | 限流拒绝率 |
| `rplace_idempotency_replay_total` | Counter | 客户端重试频率 |
| `rplace_delta_catchup_total{result="ok\|gone"}` | Counter | 追平成功率，`gone` 过多说明 Stream 太短 |
| `rplace_persistence_queue_depth` | Gauge | 消息积压，Worker 扩容信号 |
| `rplace_persistence_dropped_total` | Counter | MQ 降级期间丢弃的事件数 |
| `rplace_circuit_breaker_state{name}` | Gauge | 熔断状态：0=closed，0.5=half-open，1=open |
| `rplace_redis_evicted_keys_total` | Counter | 必须恒为 0，否则画布可能被淘汰 |

核心告警建议：

- 像素放置 P99 > 100ms 持续 1 分钟；
- `persistence_queue_depth` 持续增长超过 5 分钟；
- 任一 circuit breaker 进入 open；
- WebSocket 连接数骤降（客户端大面积断连）；
- `redis_evicted_keys_total > 0` 或 `persistence_dropped_total` 增长。

---

## 12. 故障场景与应对

| 故障 | 影响 | 应对 |
|---|---|---|
| Redis 主节点宕机 | 画布热状态不可写，限流失效 | Sentinel/Cluster 自动故障转移；熔断快速失败 503（不消耗冷却）；从快照恢复并恢复 `seq` |
| Redis 无 AOF 重启 | 位图与 seq 丢失 | `canvas-init` 从最新快照回填，并回放 `pixel_events` 中快照之后的事件，水位取 `max(快照 seq, 事件最大 seq)`；API 在 ready 前不接流量 |
| RabbitMQ/Kafka 不可用 | 持久化暂停 | 像素放置继续，事件降级 spool 或丢弃并计数；恢复后补发 |
| PostgreSQL 写入变慢 | 持久化延迟增加 | MQ 缓冲；Worker 水平扩容；不影响实时体验 |
| 单个 WebSocket 实例宕机 | 该实例客户端断连 | 指数退避重连，重连后 `/deltas` 追平或全量快照 |
| Pub/Sub 订阅闪断 | 该实例静默丢增量 | 重连后广播 `resync`，客户端按水位追平 |
| 慢客户端 | 单连接发送积压 | 256KB 队列上限，超限 4003 断开，重连后追平 |
| 客户端网络重试 | 可能重复放置 | `request_id` 幂等键，缓存结果直接重放 |
| 恶意超大坐标 | 单条请求撑爆 Redis 内存 | Lua 内 offset 边界校验，越界 422 |
| 画布被恶意高频请求 | 限流拒绝 | Redis 原子限流天然生效；边缘再加 IP 级限流与 WAF |

---

## 13. 总结

本设计的核心可以概括为四句话：

1. **快照走缓存，增量走 WebSocket**，让读和写各走各的最优路径；
2. **热状态只放在 Redis，持久化完全异步**，保证像素放置永远不被数据库拖慢；
3. **一次 Lua 脚本完成幂等 + 限流 + 写入 + 序号 + 发布**，把“失败也烧冷却”“旧增量覆盖新快照”“重试变 429”这三类错误从结构上排除；
4. **WebSocket 无状态 + Pub/Sub 扇出 + Stream 追平**，使系统可以线性水平扩展，从 docker-compose 单机平滑演进到多实例生产集群。

所有中间件通过 `docker compose up -d` 即可获得，前后端通过 §4.3 的 REST + WebSocket 契约解耦并行开发。

---

## 附录 A 后端语言选型

选 **Node.js 22 + TypeScript**，理由：

- 扇出是 I/O 密集型而非 CPU 密集型，`ws` 库在单实例 1–5 万连接的量级足够；Nginx/Node 默认 HTTP 栈成为瓶颈时，可无缝替换为 `uWebSockets.js`（API 形状相同）。
- 与前端共享 `palette`、快照头部编解码、错误码等类型定义，契约漂移风险最低。
- 单连接内存约 10–20KB（关闭 `perMessageDeflate`：增量帧很小，压缩的 CPU 代价远大于带宽收益），5 万连接约 0.5–1GB，符合单实例规划。
- 若后续需要把热路径挪到更高吞吐的运行时，Lua 脚本与 HTTP/WS 契约都不变，仅替换 `place`/`broadcast` 两个模块，属于局部重写。

Go 是合理备选（更省内存、GC 更可控），但在“与前端共享契约类型”和开发速度上不如 Node；本设计不依赖任何 Node 专属能力。
