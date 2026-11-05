import { signal, type Signal } from '@angular/core';
import { fitsCaps, type Run } from './code-tokens';

/** A block for the highlight worker; `seq` pairs the reply with its request. */
export interface HighlightRequest {
  readonly seq: number;
  readonly id: string;
  readonly code: string;
}

export interface HighlightReply {
  readonly seq: number;
  readonly lines: Run[][] | null;
}

/** The highlight worker, or null where the host cannot start one. */
export function createHighlightWorker(): Worker | null {
  if (typeof Worker === 'undefined') {
    return null;
  }
  try {
    return new Worker(new URL('./code-highlight.worker', import.meta.url), {
      type: 'module',
    });
  } catch {
    return null;
  }
}

/**
 * Sends code blocks to the highlight worker and resolves each with its runs, or null when the
 * block is over the caps, the worker could not highlight it, or the worker is gone. After the
 * first worker error it stays unavailable, and the caller uses the main-thread path instead.
 */
export class CodeHighlightClient {
  private readonly pending = new Map<number, (lines: Run[][] | null) => void>();
  private readonly ready: ReturnType<typeof signal<boolean>>;
  private worker: Worker | null;
  private seq = 0;

  readonly available: Signal<boolean>;

  constructor(createWorker: () => Worker | null) {
    this.worker = createWorker();
    this.ready = signal(this.worker !== null);
    this.available = this.ready.asReadonly();
    if (this.worker) {
      this.worker.onmessage = ({ data }: MessageEvent<HighlightReply>) => {
        this.pending.get(data.seq)?.(data.lines);
        this.pending.delete(data.seq);
      };
      this.worker.onerror = () => this.stop();
    }
  }

  request(id: string, code: string): Promise<Run[][] | null> {
    if (!this.worker || !fitsCaps(code)) {
      return Promise.resolve(null);
    }
    const seq = ++this.seq;
    const message: HighlightRequest = { seq, id, code };
    return new Promise((resolve) => {
      this.pending.set(seq, resolve);
      this.worker?.postMessage(message);
    });
  }

  private stop(): void {
    this.worker?.terminate();
    this.worker = null;
    this.ready.set(false);
    for (const resolve of this.pending.values()) resolve(null);
    this.pending.clear();
  }
}
