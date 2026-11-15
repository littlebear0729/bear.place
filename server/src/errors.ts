export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterMs?: number;

  constructor(status: number, code: string, message: string, retryAfterMs?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export const badRequest = (message = '请求格式不合法') =>
  new ApiError(400, 'bad_request', message);

export const unauthenticated = () =>
  new ApiError(401, 'unauthenticated', '未登录或会话已失效');

export const outOfBounds = () =>
  new ApiError(422, 'out_of_bounds', '坐标超出画布范围');

export const badColor = () =>
  new ApiError(422, 'bad_color', '颜色索引必须在 0–15');

export const cooldown = (ttlSeconds: number) =>
  new ApiError(429, 'cooldown', '仍在冷却中', Math.max(0, ttlSeconds) * 1000);

export const unavailable = () =>
  new ApiError(503, 'unavailable', '热路径暂时不可用');
