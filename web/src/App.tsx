import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ApiFailure,
  fetchMe,
  login,
  placePixel,
  saveCanvasSettings,
} from './api';
import { LiveClient } from './live';
import {
  HEIGHT,
  PALETTE,
  WIDTH,
  fetchMeta,
  fetchSnapshot,
  type CanvasConfig,
} from './protocol';
import { CanvasRenderer, type HoverPixel } from './renderer';

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
  const snapshotSeqRef = useRef(0);

  const [username, setUsername] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [connection, setConnection] = useState<Connection>('offline');
  const [selectedColor, setSelectedColor] = useState(5);
  const [palette, setPalette] = useState<string[]>([...PALETTE]);
  const [dims, setDims] = useState({ width: WIDTH, height: HEIGHT });
  const [hover, setHover] = useState<HoverPixel | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [serverOffset, setServerOffset] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [loginName, setLoginName] = useState('');
  const [busy, setBusy] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminWidth, setAdminWidth] = useState(String(WIDTH));
  const [adminHeight, setAdminHeight] = useState(String(HEIGHT));
  const [adminPalette, setAdminPalette] = useState<string[]>([...PALETTE]);
  const [adminBusy, setAdminBusy] = useState(false);

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

    const toWorld = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: Math.floor(
          (clientX - rect.left - renderer.camera.x) / renderer.camera.scale,
        ),
        y: Math.floor(
          (clientY - rect.top - renderer.camera.y) / renderer.camera.scale,
        ),
      };
    };

    const updateHover = (clientX: number, clientY: number) => {
      const world = toWorld(clientX, clientY);
      const inside =
        world.x >= 0 && world.x < renderer.width &&
        world.y >= 0 && world.y < renderer.height;
      renderer.setHover(inside ? world : null);
      setHover((previous) => {
        if (!inside) return previous === null ? previous : null;
        if (previous?.x === world.x && previous.y === world.y) return previous;
        return world;
      });
    };

    const onPointerMove = (event: PointerEvent) => {
      updateHover(event.clientX, event.clientY);
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
        updateHover(event.clientX, event.clientY);
      }
    };

    const onPointerLeave = () => {
      renderer.setHover(null);
      setHover(null);
    };

    const onPointerUp = async (event: PointerEvent) => {
      if (!pointer.down) return;
      pointer.down = false;
      if (pointer.dragged) return;

      const world = toWorld(event.clientX, event.clientY);
      const worldX = world.x;
      const worldY = world.y;
      if (
        worldX < 0 || worldX >= renderer.width ||
        worldY < 0 || worldY >= renderer.height
      ) {
        return;
      }

      const current = stateRef.current;
      if (!current.username) {
        setToast('请先登录再放置像素');
        return;
      }
      if (Date.now() + current.serverOffset < current.cooldownUntil) {
        setToast('冷却中，稍后再试');
        return;
      }

      const index = worldY * renderer.width + worldX;
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
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    const live = new LiveClient(renderer, {
      onState: setConnection,
      onHello: (_seq, serverTime, cooldownMs) => {
        setServerOffset(serverTime - Date.now());
        if (cooldownMs > 0) setCooldownUntil(serverTime + cooldownMs);
      },
      onConfig: (config: CanvasConfig) => {
        setPalette(config.palette);
        setDims({ width: config.width, height: config.height });
        setSelectedColor((previous) =>
          previous < config.palette.length ? previous : 0,
        );
      },
      onError: setToast,
      onAuthRequired: () => {
        setUsername(null);
        setIsAdmin(false);
        setToast('会话已过期，请重新登录');
      },
    });
    liveRef.current = live;

    let cancelled = false;
    const initialize = async () => {
      const [metaResult, snapshotResult] = await Promise.allSettled([
        fetchMeta(),
        fetchSnapshot(),
      ]);
      if (cancelled) return;

      let activePalette = renderer.getPalette();
      if (metaResult.status === 'fulfilled') {
        const meta = metaResult.value;
        activePalette = meta.palette;
        renderer.configure(meta.width, meta.height, meta.palette);
        renderer.fit(wrap.clientWidth, wrap.clientHeight);
        setPalette(meta.palette);
        setDims({ width: meta.width, height: meta.height });
        setSelectedColor((previous) =>
          previous < meta.palette.length ? previous : 0,
        );
        setServerOffset(meta.server_time - Date.now());
      }

      if (snapshotResult.status === 'fulfilled') {
        const snapshot = snapshotResult.value;
        renderer.configure(snapshot.width, snapshot.height, activePalette);
        renderer.load(snapshot.pixels);
        snapshotSeqRef.current = snapshot.seq;
        if (metaResult.status !== 'fulfilled') {
          setDims({ width: snapshot.width, height: snapshot.height });
          renderer.fit(wrap.clientWidth, wrap.clientHeight);
        }
      }

      const me = await fetchMe().catch(() => undefined);
      if (cancelled || !me) return;
      setUsername(me.username);
      setIsAdmin(me.is_admin);
      live.connect(snapshotSeqRef.current);
    };
    void initialize();

    return () => {
      cancelled = true;
      resizeObserver.disconnect();
      cancelAnimationFrame(raf);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('pointerleave', onPointerLeave);
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
      setIsAdmin(me.is_admin);
      setLoginName('');
      liveRef.current?.connect(snapshotSeqRef.current);
    } catch (error) {
      setToast(error instanceof ApiFailure ? error.message : '登录失败');
    } finally {
      setBusy(false);
    }
  };

  const openAdminPanel = () => {
    setAdminWidth(String(dims.width));
    setAdminHeight(String(dims.height));
    setAdminPalette([...palette]);
    setAdminOpen(true);
  };

  const updateAdminColor = (index: number, value: string) => {
    setAdminPalette((previous) =>
      previous.map((hex, i) => (i === index ? value.toUpperCase() : hex)),
    );
  };

  const removeAdminColor = (index: number) => {
    setAdminPalette((previous) =>
      previous.length <= 1 ? previous : previous.filter((_, i) => i !== index),
    );
  };

  const addAdminColor = () => {
    setAdminPalette((previous) =>
      previous.length >= 256 ? previous : [...previous, '#FFFFFF'],
    );
  };

  const submitAdmin = async (event: FormEvent) => {
    event.preventDefault();
    if (adminBusy) return;
    const width = Number(adminWidth);
    const height = Number(adminHeight);
    if (
      !Number.isInteger(width) || width < 16 || width > 4096 ||
      !Number.isInteger(height) || height < 16 || height > 4096
    ) {
      setToast('宽高必须是 16–4096 的整数');
      return;
    }
    if (
      adminPalette.length < 1 || adminPalette.length > 256 ||
      adminPalette.some((hex) => !/^#[0-9A-F]{6}$/.test(hex))
    ) {
      setToast('颜色必须是 1–256 个 #RRGGBB');
      return;
    }
    if (
      (width !== dims.width || height !== dims.height) &&
      !window.confirm('调整画布尺寸会清空当前画布内容，确认继续？')
    ) {
      return;
    }

    setAdminBusy(true);
    try {
      const result = await saveCanvasSettings(width, height, adminPalette);
      rendererRef.current?.configure(result.width, result.height, result.palette);
      const snapshot = await fetchSnapshot(true);
      rendererRef.current?.configure(snapshot.width, snapshot.height, result.palette);
      rendererRef.current?.load(snapshot.pixels);
      snapshotSeqRef.current = snapshot.seq;
      setPalette(result.palette);
      setDims({ width: result.width, height: result.height });
      setSelectedColor((previous) =>
        previous < result.palette.length ? previous : 0,
      );
      setAdminOpen(false);
      setToast('画布设置已更新');
    } catch (error) {
      setToast(error instanceof ApiFailure ? error.message : '保存失败');
    } finally {
      setAdminBusy(false);
    }
  };

  const serverNow = now + serverOffset;
  const remaining = Math.max(0, cooldownUntil - serverNow);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">bear.place</div>
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
          <div className="cursor-readout" aria-live="off">
            {hover ? `x ${hover.x} · y ${hover.y}` : 'x — · y —'}
          </div>
        </div>
        <aside className="sidebar">
          <h2>调色板</h2>
          <div className="palette">
            {palette.map((hex, index) => (
              <button
                key={`${index}-${hex}`}
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
            画布 {dims.width}×{dims.height} · 颜色 {selectedColor} / {palette.length}
          </p>
          {isAdmin && (
            <section className="admin">
              <h2>管理</h2>
              {!adminOpen ? (
                <button type="button" onClick={openAdminPanel}>
                  调整画布
                </button>
              ) : (
                <form className="admin-form" onSubmit={submitAdmin}>
                  <div className="admin-size">
                    <label>
                      宽
                      <input
                        type="number"
                        min={16}
                        max={4096}
                        value={adminWidth}
                        onChange={(event) => setAdminWidth(event.target.value)}
                      />
                    </label>
                    <label>
                      高
                      <input
                        type="number"
                        min={16}
                        max={4096}
                        value={adminHeight}
                        onChange={(event) => setAdminHeight(event.target.value)}
                      />
                    </label>
                  </div>
                  <p className="hint">颜色 {adminPalette.length} 种（1–256）</p>
                  <div className="admin-colors">
                    {adminPalette.map((hex, index) => (
                      <div className="admin-color" key={index}>
                        <input
                          type="color"
                          value={hex.toLowerCase()}
                          onChange={(event) => updateAdminColor(index, event.target.value)}
                          aria-label={`颜色 ${index}`}
                        />
                        <code>{hex}</code>
                        <button
                          type="button"
                          className="ghost"
                          disabled={adminPalette.length <= 1}
                          onClick={() => removeAdminColor(index)}
                        >
                          删除
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="admin-actions">
                    <button
                      type="button"
                      onClick={addAdminColor}
                      disabled={adminPalette.length >= 256}
                    >
                      添加颜色
                    </button>
                    <button type="submit" disabled={adminBusy}>
                      {adminBusy ? '保存中…' : '保存'}
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => setAdminOpen(false)}
                    >
                      取消
                    </button>
                  </div>
                </form>
              )}
            </section>
          )}
        </aside>
      </main>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
