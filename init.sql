-- r/place 初始化 schema（与 DESIGN.md §8 一致）
-- 由 docker-entrypoint-initdb.d 在数据库首次创建时执行。

CREATE TABLE users (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username    TEXT        NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pixel_events (
    id          BIGSERIAL PRIMARY KEY,
    seq         BIGINT      NOT NULL,
    user_id     BIGINT      NOT NULL REFERENCES users(id),
    x           INT         NOT NULL CHECK (x >= 0),
    y           INT         NOT NULL CHECK (y >= 0),
    color       SMALLINT    NOT NULL CHECK (color BETWEEN 0 AND 15),
    placed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    request_id  TEXT        NOT NULL
);

CREATE UNIQUE INDEX idx_events_seq       ON pixel_events (seq);
CREATE UNIQUE INDEX idx_events_request   ON pixel_events (request_id);
CREATE INDEX        idx_events_placed_at ON pixel_events (placed_at);
CREATE INDEX        idx_events_user      ON pixel_events (user_id, placed_at DESC);

CREATE TABLE canvas_snapshots (
    id          BIGSERIAL PRIMARY KEY,
    canvas_id   TEXT        NOT NULL DEFAULT 'main',
    seq         BIGINT      NOT NULL,
    canvas_data BYTEA       NOT NULL CHECK (octet_length(canvas_data) = 1000000),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_snapshots_latest ON canvas_snapshots (canvas_id, id DESC);
