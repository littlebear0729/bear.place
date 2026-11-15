import { HEIGHT, PALETTE_RGB, WIDTH } from './protocol';

export interface Camera {
  scale: number;
  x: number;
  y: number;
}

export class CanvasRenderer {
  readonly width = WIDTH;
  readonly height = HEIGHT;
  readonly camera: Camera = { scale: 1, x: 0, y: 0 };
  onChange: () => void = () => {};

  private readonly pixels = new Uint8Array(WIDTH * HEIGHT);
  private readonly image: ImageData;
  private readonly offscreen: HTMLCanvasElement;
  private readonly offCtx: CanvasRenderingContext2D;
  private dirty = true;

  constructor() {
    this.offscreen = document.createElement('canvas');
    this.offscreen.width = WIDTH;
    this.offscreen.height = HEIGHT;
    const ctx = this.offscreen.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D 不可用');
    this.offCtx = ctx;
    this.image = ctx.createImageData(WIDTH, HEIGHT);
    this.fillImage();
    this.offCtx.putImageData(this.image, 0, 0);
  }

  private fillImage(): void {
    const data = this.image.data;
    for (let index = 0; index < this.pixels.length; index += 1) {
      const rgb = PALETTE_RGB[this.pixels[index]] ?? PALETTE_RGB[0];
      const offset = index * 4;
      data[offset] = rgb[0];
      data[offset + 1] = rgb[1];
      data[offset + 2] = rgb[2];
      data[offset + 3] = 255;
    }
  }

  load(pixels: Uint8Array): void {
    this.pixels.fill(0);
    const count = Math.min(pixels.length, this.pixels.length);
    this.pixels.set(pixels.subarray(0, count));
    this.fillImage();
    this.invalidate();
  }

  setPixel(index: number, color: number): void {
    if (index < 0 || index >= this.pixels.length) return;
    const safeColor = color >= 0 && color < PALETTE_RGB.length ? color : 0;
    this.pixels[index] = safeColor;
    const rgb = PALETTE_RGB[safeColor];
    const offset = index * 4;
    const data = this.image.data;
    data[offset] = rgb[0];
    data[offset + 1] = rgb[1];
    data[offset + 2] = rgb[2];
    data[offset + 3] = 255;
    this.dirty = true;
    this.invalidate();
  }

  getPixel(index: number): number {
    return this.pixels[index] ?? 0;
  }

  invalidate(): void {
    this.onChange();
  }

  fit(cssWidth: number, cssHeight: number): void {
    if (cssWidth <= 0 || cssHeight <= 0) return;
    const scale = Math.min(cssWidth / WIDTH, cssHeight / HEIGHT) * 0.95;
    this.camera.scale = scale;
    this.camera.x = (cssWidth - WIDTH * scale) / 2;
    this.camera.y = (cssHeight - HEIGHT * scale) / 2;
    this.invalidate();
  }

  zoomAt(screenX: number, screenY: number, factor: number): void {
    const next = Math.min(64, Math.max(0.05, this.camera.scale * factor));
    const worldX = (screenX - this.camera.x) / this.camera.scale;
    const worldY = (screenY - this.camera.y) / this.camera.scale;
    this.camera.scale = next;
    this.camera.x = screenX - worldX * next;
    this.camera.y = screenY - worldY * next;
    this.invalidate();
  }

  paint(ctx: CanvasRenderingContext2D, cssWidth: number, cssHeight: number): void {
    if (this.dirty) {
      this.offCtx.putImageData(this.image, 0, 0);
      this.dirty = false;
    }
    ctx.save();
    ctx.fillStyle = '#0b0d10';
    ctx.fillRect(0, 0, cssWidth, cssHeight);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      this.offscreen,
      this.camera.x,
      this.camera.y,
      WIDTH * this.camera.scale,
      HEIGHT * this.camera.scale,
    );
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.strokeRect(
      this.camera.x,
      this.camera.y,
      WIDTH * this.camera.scale,
      HEIGHT * this.camera.scale,
    );
    ctx.restore();
  }
}
