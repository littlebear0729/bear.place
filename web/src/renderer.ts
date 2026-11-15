import { HEIGHT, PALETTE, WIDTH } from './protocol';

export interface Camera {
  scale: number;
  x: number;
  y: number;
}

export interface HoverPixel {
  x: number;
  y: number;
}

type Rgb = readonly [number, number, number];

function parsePalette(palette: readonly string[]): Rgb[] {
  return palette.map((hex) => {
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return [255, 255, 255] as const;
    const value = Number.parseInt(hex.slice(1), 16);
    return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff] as const;
  });
}

export class CanvasRenderer {
  width = 0;
  height = 0;
  readonly camera: Camera = { scale: 1, x: 0, y: 0 };
  onChange: () => void = () => {};

  private pixels = new Uint8Array(0);
  private image!: ImageData;
  private readonly offscreen: HTMLCanvasElement;
  private readonly offCtx: CanvasRenderingContext2D;
  private paletteHex: string[] = [...PALETTE];
  private paletteRgb: Rgb[] = parsePalette(PALETTE);
  private dirty = true;
  private lastCssWidth = 0;
  private lastCssHeight = 0;
  private hoverPixel: HoverPixel | null = null;

  constructor() {
    this.offscreen = document.createElement('canvas');
    const ctx = this.offscreen.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D 不可用');
    this.offCtx = ctx;
    this.configure(WIDTH, HEIGHT, [...PALETTE]);
  }

  getPalette(): string[] {
    return [...this.paletteHex];
  }

  configure(width: number, height: number, palette: string[]): boolean {
    const sizeChanged = width !== this.width || height !== this.height;
    const paletteChanged =
      palette.length !== this.paletteHex.length ||
      palette.some((hex, index) => hex !== this.paletteHex[index]);
    if (!sizeChanged && !paletteChanged) return false;

    if (sizeChanged) {
      this.width = width;
      this.height = height;
      this.pixels = new Uint8Array(width * height);
      this.offscreen.width = width;
      this.offscreen.height = height;
      this.image = this.offCtx.createImageData(width, height);
      this.hoverPixel = null;
    }

    this.paletteHex = [...palette];
    this.paletteRgb = parsePalette(palette);
    this.fillImage();
    this.dirty = true;
    if (sizeChanged && this.lastCssWidth > 0 && this.lastCssHeight > 0) {
      this.fit(this.lastCssWidth, this.lastCssHeight);
    } else {
      this.invalidate();
    }
    return true;
  }

  private fillImage(): void {
    const data = this.image.data;
    const fallback = this.paletteRgb[0] ?? ([255, 255, 255] as const);
    for (let index = 0; index < this.pixels.length; index += 1) {
      const rgb = this.paletteRgb[this.pixels[index]] ?? fallback;
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
    this.dirty = true;
    this.invalidate();
  }

  setPixel(index: number, color: number): void {
    if (index < 0 || index >= this.pixels.length) return;
    const safeColor = color >= 0 && color < this.paletteRgb.length ? color : 0;
    this.pixels[index] = safeColor;
    const rgb = this.paletteRgb[safeColor] ?? ([255, 255, 255] as const);
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

  setHover(pixel: HoverPixel | null): void {
    const next =
      pixel && pixel.x >= 0 && pixel.y >= 0 && pixel.x < this.width && pixel.y < this.height
        ? pixel
        : null;
    if (next?.x === this.hoverPixel?.x && next?.y === this.hoverPixel?.y) return;
    this.hoverPixel = next;
    this.invalidate();
  }

  invalidate(): void {
    this.onChange();
  }

  fit(cssWidth: number, cssHeight: number): void {
    if (cssWidth <= 0 || cssHeight <= 0) return;
    const scale = Math.min(cssWidth / this.width, cssHeight / this.height) * 0.95;
    this.camera.scale = scale;
    this.camera.x = (cssWidth - this.width * scale) / 2;
    this.camera.y = (cssHeight - this.height * scale) / 2;
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
    this.lastCssWidth = cssWidth;
    this.lastCssHeight = cssHeight;
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
      this.width * this.camera.scale,
      this.height * this.camera.scale,
    );
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.strokeRect(
      this.camera.x,
      this.camera.y,
      this.width * this.camera.scale,
      this.height * this.camera.scale,
    );

    if (this.hoverPixel) {
      const scale = this.camera.scale;
      const size = Math.max(scale, 4);
      const left = this.camera.x + this.hoverPixel.x * scale - (size - scale) / 2;
      const top = this.camera.y + this.hoverPixel.y * scale - (size - scale) / 2;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.9)';
      ctx.strokeRect(left, top, size, size);
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#ffffff';
      ctx.strokeRect(left + 1, top + 1, Math.max(0, size - 2), Math.max(0, size - 2));
    }
    ctx.restore();
  }
}
