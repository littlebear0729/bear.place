import { isRecord } from './guards';

export class ApiFailure extends Error {
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

async function failureFrom(res: Response): Promise<ApiFailure> {
  let code = 'http_error';
  let message = `请求失败 (${res.status})`;
  let retryAfterMs: number | undefined;
  try {
    const body: unknown = await res.json();
    if (isRecord(body) && isRecord(body.error)) {
      if (typeof body.error.code === 'string') code = body.error.code;
      if (typeof body.error.message === 'string') message = body.error.message;
      if (typeof body.error.retry_after_ms === 'number') {
        retryAfterMs = body.error.retry_after_ms;
      }
    }
  } catch {
    /* 非 JSON 错误体，保留默认文案 */
  }
  return new ApiFailure(res.status, code, message, retryAfterMs);
}

export async function login(
  username: string,
): Promise<{ user_id: number; username: string }> {
  const res = await fetch('/api/dev/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  if (!res.ok) throw await failureFrom(res);
  const body: unknown = await res.json();
  if (
    !isRecord(body) ||
    typeof body.user_id !== 'number' ||
    typeof body.username !== 'string'
  ) {
    throw new ApiFailure(500, 'bad_response', '登录响应异常');
  }
  return { user_id: body.user_id, username: body.username };
}

export async function fetchMe(): Promise<{ user_id: number; username: string | null } | null> {
  const res = await fetch('/api/me');
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`me HTTP ${res.status}`);
  const body: unknown = await res.json();
  if (!isRecord(body) || typeof body.user_id !== 'number') throw new Error('me malformed');
  return {
    user_id: body.user_id,
    username: typeof body.username === 'string' ? body.username : null,
  };
}

export async function placePixel(
  x: number,
  y: number,
  color: number,
): Promise<{ seq: number; next_placement_at: number }> {
  const res = await fetch('/api/pixels', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ x, y, color, request_id: crypto.randomUUID() }),
  });
  if (!res.ok) throw await failureFrom(res);
  const body: unknown = await res.json();
  if (
    !isRecord(body) ||
    typeof body.seq !== 'number' ||
    typeof body.next_placement_at !== 'number'
  ) {
    throw new ApiFailure(500, 'bad_response', '放置响应异常');
  }
  return { seq: body.seq, next_placement_at: body.next_placement_at };
}
