import amqp from 'amqplib';
import { appendSpool, type PixelEvent } from './spool.js';
import { persistenceDropped, persistenceSpooled } from './metrics.js';

let channel: amqp.Channel | null = null;
let queueName = 'pixel.events';
let amqpUrl = '';
let spoolDir = '';
let reconnecting = false;

async function connect(): Promise<void> {
  if (channel) return;
  try {
    const connection = await amqp.connect(amqpUrl);
    connection.on('close', () => {
      channel = null;
      scheduleReconnect();
    });
    connection.on('error', () => {
      channel = null;
    });
    const ch = await connection.createChannel();
    await ch.assertQueue(queueName, { durable: true });
    channel = ch;
  } catch {
    channel = null;
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (reconnecting) return;
  reconnecting = true;
  setTimeout(() => {
    reconnecting = false;
    void connect();
  }, 2000);
}

export async function initPublisher(
  url: string,
  queue: string,
  spoolDirectory: string,
): Promise<void> {
  amqpUrl = url;
  queueName = queue;
  spoolDir = spoolDirectory;
  await connect();
}

export async function publishEvent(event: PixelEvent): Promise<'queued' | 'spooled' | 'dropped'> {
  if (!channel) {
    void connect();
    return fallback(event);
  }
  try {
    const ok = channel.sendToQueue(queueName, Buffer.from(JSON.stringify(event)), {
      persistent: true,
      contentType: 'application/json',
    });
    if (!ok) {
      // 通道写缓冲已满：不阻塞热路径，降级到 spool。
      return fallback(event);
    }
    return 'queued';
  } catch {
    channel = null;
    scheduleReconnect();
    return fallback(event);
  }
}

async function fallback(event: PixelEvent): Promise<'spooled' | 'dropped'> {
  try {
    await appendSpool(spoolDir, event);
    persistenceSpooled.inc();
    return 'spooled';
  } catch {
    persistenceDropped.inc();
    return 'dropped';
  }
}
