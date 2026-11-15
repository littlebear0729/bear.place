import { appendFile, mkdir, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface PixelEvent {
  seq: number;
  user_id: number;
  x: number;
  y: number;
  color: number;
  placed_at: number;
  request_id: string;
}

export async function appendSpool(spoolDir: string, event: PixelEvent): Promise<void> {
  await mkdir(spoolDir, { recursive: true });
  await appendFile(join(spoolDir, 'spool.ndjson'), JSON.stringify(event) + '\n', 'utf8');
}

export async function drainSpool(
  spoolDir: string,
  handle: (events: PixelEvent[]) => Promise<void>,
): Promise<number> {
  let names: string[];
  try {
    names = await readdir(spoolDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }

  let drained = 0;
  for (const name of names) {
    if (!name.endsWith('.ndjson')) continue;
    const source = join(spoolDir, name);
    const claimed = `${source}.processing-${randomUUID()}`;
    try {
      await rename(source, claimed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }

    const raw = await readFile(claimed, 'utf8');
    const events: PixelEvent[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as PixelEvent);
      } catch {
        // 损坏行丢弃，不让单行阻塞整个 spool。
      }
    }
    if (events.length > 0) {
      await handle(events);
      drained += events.length;
    }
    await unlink(claimed);
  }
  return drained;
}
