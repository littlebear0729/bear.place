import promClient from 'prom-client';
import { registry } from './metrics.js';

const { Gauge } = promClient;

export const breakerState = new Gauge({
  name: 'rplace_circuit_breaker_state',
  help: '熔断状态：0=closed，0.5=half-open，1=open',
  labelNames: ['name'],
  registers: [registry],
});

export class Breaker {
  private failures = 0;
  private openedAt = 0;
  private state = 0;

  constructor(
    private readonly name: string,
    private readonly threshold = 5,
    private readonly cooldownMs = 5000,
  ) {
    breakerState.set({ name }, 0);
  }

  get isOpen(): boolean {
    if (this.state === 1 && Date.now() - this.openedAt >= this.cooldownMs) {
      this.state = 0.5;
      breakerState.set({ name: this.name }, 0.5);
    }
    return this.state === 1;
  }

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.isOpen) {
      throw new Error(`circuit_open:${this.name}`);
    }
    try {
      const result = await fn();
      this.failures = 0;
      if (this.state !== 0) {
        this.state = 0;
        breakerState.set({ name: this.name }, 0);
      }
      return result;
    } catch (error) {
      this.failures += 1;
      if (this.failures >= this.threshold) {
        this.state = 1;
        this.openedAt = Date.now();
        breakerState.set({ name: this.name }, 1);
      }
      throw error;
    }
  }
}
