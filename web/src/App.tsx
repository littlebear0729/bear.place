import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiFailure, fetchMe, login, placePixel } from './api';
import { LiveClient } from './live';
import { HEIGHT, PALETTE, WIDTH } from './protocol';
import { CanvasRenderer } from './renderer';

type Connection = 'offline' | 'connecting' | 'live';

function formatDuration(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function App() {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<CanvasRenderer | null>(null);
  const liveRef = useRef<LiveClient | null>(null);

  const [username, setUsername] = useState<string | null>(null);
  const [connection, setConnection] = useState<Connection>('offline');
  const [selectedColor, setSelectedColor] = useState(5);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [serverOffset, setServerOffset] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [loginName, setLoginName] = useState('');
  const [busy, setBusy] = useState(false);

  const stateRef = useRef({ username, selectedColor, cooldownUntil, serverOffset });
  stateRef.current = { username, selectedColor, cooldownUntil, serverOffset };

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;

    const renderer = new CanvasRenderer();
    rendererRef.current = renderer;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    renderer.fit(wrap.clientWidth, wrap.clientHeight);
    let needsPaint = true;
    renderer.onChange = () => {
      needsPaint = true;
    };

    let raf = 0;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const cssWidth = wrap.clientWidth;
      const cssHeight = wrap.clientHeight;
      const pixelWidth = Math.max(1, Math.floor(cssWidth * dpr));
      const pixelHeight = Math.max(1, Math.floor(cssHeight * dpr));
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
        canvas.style.width = `${cssWidth}px`;
        canvas.style.height = `${cssHeight}px`;
        needsPaint = true;
      }
      if (needsPaint) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        renderer.paint(ctx, cssWidth, cssHeight);
        needsPaint = false;
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    const resizeObserver = new ResizeObserver(() => {
      needsPaint = true;
    });
    resizeObserver.observe(wrap);

    const pointer = { down: false, dragged: false, lastX: 0, lastY: 0 };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      pointer.down = true;
      pointer.dragged = false;
      pointer.lastX = event.clientX;
      pointer.lastY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!pointer.down) return;
      const dx = event.clientX - pointer.lastX;
      const dy = event.clientY - pointer.lastY;
      if (Math.abs(dx) + Math.abs(dy) > 2) pointer.dragged = true;
      pointer.lastX = event.clientX;
      pointer.lastY = event.clientY;
      if (pointer.dragged) {
        renderer.camera.x += dx;
        renderer.camera.y += dy;
        renderer.invalidate();
      }
    };

    const onPointerUp = async (event: PointerEvent) => {
      if (!pointer.down) return;
      pointer.down = false;
      if (pointer.dragged) return;

      const rect = canvas.getBoundingClientRect();
      const worldX = Math.floor(
        (event.clientX - rect.left - renderer.camera.x) / renderer.camera.scale,
      );
      const worldY = Math.floor(
        (event.clientY - rect.top - renderer.camera.y) / renderer.camera.scale,
      );
      if (worldX < 0 || worldX >= WIDTH || worldY < 0 || worldY >= HEIGHT) return;

      const current = stateRef.current;
      if (!current.username) {
        setToast('请先登录再放置像素');
        return;
      }
      if (Date.now() + current.serverOffset < current.cooldownUntil) {
        setToast('冷却中，稍后再试');
        return;
      }

      const index = worldY * WIDTH + worldX;
      const previous = renderer.getPixel(index);
      renderer.setPixel(index, current.selectedColor);
      try {
        const result = await placePixel(worldX, worldY, current.selectedColor);
        setCooldownUntil(result.next_placement_at);
      } catch (error) {
        renderer.setPixel(index, previous);
        if (error instanceof ApiFailure) {
          if (error.status === 429 && error.retryAfterMs !== undefined) {
            setCooldownUntil(Date.now() + stateRef.current.serverOffset + error.retryAfterMs);
            setToast('冷却中，稍后再试');
          } else {
            setToast(error.message);
          }
        } else {
          setToast('网络错误，请重试');
        }
      }
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      renderer.zoomAt(
        event.clientX - rect.left,
        event.clientY - rect.top,
        Math.exp(-event.deltaY * 0.0015),
      );
    };

    const onPointerCancel = () => {
      pointer.down = false;
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerCancel);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    const live = new LiveClient(renderer, {
      onState: setConnection,
      onHello: (_seq, serverTime, cooldownMs) => {
        setServerOffset(serverTime - Date.now());
        if (cooldownMs > 0) setCooldownUntil(serverTime + cooldownMs);
      },
      onError: setToast,
      onAuthRequired: () => {
        setUsername(null);
        setToast('会话已过期，请重新登录');
      },
    });
    liveRef.current = live;

    let cancelled = false;
    void fetchMe()
      .then((me) => {
        if (cancelled || !me) return;
        setUsername(me.username);
        live.connect();
      })
      .catch(() => {
        /* 未登录或服务尚未就绪，保留登录表单 */
      });

    return () => {
      cancelled = true;
      resizeObserver.disconnect();
      cancelAnimationFrame(raf);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('wheel', onWheel);
      live.disconnect();
      rendererRef.current = null;
      liveRef.current = null;
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const submitLogin = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const me = await login(loginName);
      setUsername(me.username);
      setLoginName('');
      liveRef.current?.connect();
    } catch (error) {
      setToast(error instanceof ApiFailure ? error.message : '登录失败');
    } finally {
      setBusy(false);
    }
  };

  const serverNow = now + serverOffset;
  const remaining = Math.max(0, cooldownUntil - serverNow);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">r/place</div>
        <div className={`conn conn-${connection}`}>
          {connection === 'live' ? '实时' : connection === 'connecting' ? '同步中' : '离线'}
        </div>
        <div className="spacer" />
        {username ? (
          <div className="user">{username}</div>
        ) : (
          <form className="login" onSubmit={submitLogin}>
            <input
              value={loginName}
              onChange={(event) => setLoginName(event.target.value)}
              placeholder="用户名"
              maxLength={32}
              aria-label="用户名"
            />
            <button type="submit" disabled={busy}>
              登录
            </button>
          </form>
        )}
      </header>

      <main className="stage">
        <div className="canvas-wrap" ref={wrapRef}>
          <canvas className="board" ref={canvasRef} />
        </div>
        <aside className="sidebar">
          <h2>调色板</h2>
          <div className="palette">
            {PALETTE.map((hex, index) => (
              <button
                key={hex}
                type="button"
                className={`swatch${index === selectedColor ? ' selected' : ''}`}
                style={{ background: hex }}
                onClick={() => setSelectedColor(index)}
                aria-label={`颜色 ${index}`}
              />
            ))}
          </div>
          <div className="cooldown">
            <span>冷却</span>
            <strong>{remaining > 0 ? formatDuration(remaining) : '就绪'}</strong>
          </div>
          <p className="hint">滚轮缩放 · 拖拽平移 · 单击放置</p>
          <p className="meta">
            画布 {WIDTH}×{HEIGHT} · 颜色 {selectedColor}
          </p>
        </aside>
      </main>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
