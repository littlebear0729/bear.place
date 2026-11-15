import { fetchMe } from './api';
import {
  PALETTE,
  fetchDeltas,
  fetchMeta,
  fetchSnapshot,
  parseFrame,
  type CanvasConfig,
  type ServerFrame,
} from './protocol';
import type { CanvasRenderer } from './renderer';

export interface LiveCallbacks {
  onState: (state: 'connecting' | 'live' | 'offline') => void;
  onHello: (seq: number, serverTime: number, cooldownMs: number) => void;
  onConfig: (config: CanvasConfig) => void;
  onError: (message: string) => void;
  onAuthRequired: () => void;
}

type PixelFrame = Extract<ServerFrame, { t: 'px' }>;

export class LiveClient {
  private socket: WebSocket | null = null;
  private watermark = 0;
  private buffering = true;
  private buffer: PixelFrame[] = [];
  private attempts = 0;
  private retryTimer: number | null = null;
  private stopped = false;
  private syncing = false;
  private palette: string[] = [...PALETTE];

  constructor(
    private readonly renderer: CanvasRenderer,
    private readonly callbacks: LiveCallbacks,
  ) {}

  connect(initialSeq?: number): void {
    this.stopped = false;
    this.attempts = 0;
    this.buffering = true;
    if (initialSeq !== undefined) this.watermark = initialSeq;
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.close();
      this.socket = null;
    }
    this.open();
  }

  disconnect(): void {
    this.stopped = true;
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.close();
      this.socket = null;
    }
  }

  private open(): void {
    if (this.stopped) return;
    this.callbacks.onState('connecting');
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
    this.socket = socket;

    socket.onopen = () => {
      this.attempts = 0;
    };
    socket.onmessage = (event) => this.handleMessage(String(event.data));
    socket.onclose = () => {
      this.callbacks.onState('offline');
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      /* 随后必然触发 close */
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer !== null) return;
    this.attempts += 1;
    const base = Math.min(30_000, 1000 * 2 ** Math.min(this.attempts - 1, 5));
    const delayMs = base * (0.8 + Math.random() * 0.4);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      void this.retry();
    }, delayMs);
  }

  private async retry(): Promise<void> {
    if (this.stopped) return;
    if (this.attempts >= 2) {
      const me = await fetchMe().catch(() => undefined);
      if (me === null) {
        this.stopped = true;
        this.callbacks.onAuthRequired();
        return;
      }
    }
    this.open();
  }

  private handleMessage(raw: string): void {
    const frame = parseFrame(raw);
    if (!frame) return;

    if (frame.t === 'hello') {
      this.buffering = true;
      this.buffer = [];
      this.applyConfig(frame.width, frame.height, frame.palette, frame.seq);
      this.callbacks.onHello(frame.seq, frame.server_time, frame.cooldown_ms);
      void this.initialSync(frame.seq);
      return;
    }
    if (frame.t === 'config') {
      this.buffering = true;
      this.buffer = [];
      this.applyConfig(frame.width, frame.height, frame.palette, frame.seq);
      void this.initialSync(frame.seq, true);
      return;
    }
    if (frame.t === 'px') {
      if (this.buffering) this.buffer.push(frame);
      else this.apply(frame);
      return;
    }
    if (frame.t === 'ping') {
      this.send({ t: 'pong' });
      return;
    }
    if (frame.t === 'resync') {
      void this.catchUp();
    }
  }

  private applyConfig(
    width: number,
    height: number,
    palette: string[],
    seq: number,
  ): void {
    this.palette = [...palette];
    this.renderer.configure(width, height, this.palette);
    this.callbacks.onConfig({ width, height, palette: [...palette], seq });
  }

  private send(payload: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  private async initialSync(helloSeq: number, forceSnapshot = false): Promise<void> {
    if (!forceSnapshot && this.watermark >= helloSeq) {
      this.finishSync();
      return;
    }
    try {
      const snapshot = await fetchSnapshot(forceSnapshot);
      this.renderer.configure(snapshot.width, snapshot.height, this.palette);
      this.renderer.load(snapshot.pixels);
      this.watermark = snapshot.seq;

      if (this.watermark < helloSeq) {
        const deltas = await fetchDeltas(this.watermark);
        if (deltas === null) {
          const fresh = await fetchSnapshot(true);
          this.renderer.load(fresh.pixels);
          this.watermark = fresh.seq;
        } else {
          this.applyDeltas(deltas.d);
          this.watermark = Math.max(this.watermark, deltas.to);
        }
      }
      this.finishSync();
    } catch {
      this.callbacks.onError('画布同步失败，正在重试');
      this.socket?.close();
    }
  }

  private async catchUp(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    this.buffering = true;
    try {
      const deltas = await fetchDeltas(this.watermark);
      if (deltas === null) {
        const [snapshot, meta] = await Promise.all([
          fetchSnapshot(true),
          fetchMeta().catch(() => null),
        ]);
        if (meta) this.applyConfig(meta.width, meta.height, meta.palette, snapshot.seq);
        this.renderer.configure(snapshot.width, snapshot.height, this.palette);
        this.renderer.load(snapshot.pixels);
        this.watermark = snapshot.seq;
      } else {
        this.applyDeltas(deltas.d);
        this.watermark = Math.max(this.watermark, deltas.to);
      }
      this.finishSync();
    } catch {
      this.callbacks.onError('追平失败，正在重连');
      this.socket?.close();
    } finally {
      this.syncing = false;
    }
  }

  private finishSync(): void {
    this.buffering = false;
    const buffered = this.buffer
      .filter((frame) => frame.s > this.watermark)
      .sort((a, b) => a.s - b.s);
    this.buffer = [];
    for (const frame of buffered) this.apply(frame);
    this.callbacks.onState('live');
  }

  private applyDeltas(
    deltas: ReadonlyArray<{ s: number; i: number; c: number }>,
  ): void {
    const ordered = [...deltas].sort((a, b) => a.s - b.s);
    for (const delta of ordered) {
      this.renderer.setPixel(delta.i, delta.c);
      if (delta.s > this.watermark) this.watermark = delta.s;
    }
  }

  private apply(frame: PixelFrame): void {
    if (frame.s <= this.watermark) return;
    for (const [index, color] of frame.d) this.renderer.setPixel(index, color);
    this.watermark = frame.s;
  }
}
