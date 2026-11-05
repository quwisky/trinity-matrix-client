import { signal, type Signal } from '@angular/core';
import { fitsCaps, type Run } from './code-tokens';

/** A block for the highlight worker; `seq` pairs the reply with its request. */
export interface HighlightRequest {
  readonly seq: number;
  readonly id: string;
  readonly code: string;
}

/** Runs to show, nothing to colour, or try again later (its grammar failed to load). */
export type HighlightResult =
  | { readonly kind: 'lines'; readonly lines: Run[][] }
  | { readonly kind: 'plain' }
  | { readonly kind: 'retry' };

export interface HighlightReply {
  readonly seq: number;
  readonly result: HighlightResult;
}

/**
 * How long one block may take in the worker. Real blocks take a few milliseconds; a grammar that
 * loops on crafted input never answers, and every later block would queue behind it.
 */
export const REQUEST_DEADLINE_MS = 2_000;

const PLAIN: HighlightResult = { kind: 'plain' };

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
 * Sends code blocks to the highlight worker and resolves each with its result. A worker error
 * makes the client unavailable for the session, so the caller uses the main-thread path. A block
 * that misses its deadline restarts the worker instead: the main thread must not run the input
 * that hung it, so the blocks waiting then stay plain.
 */
export class CodeHighlightClient {
  private readonly pending = new Map<
    number,
    {
      readonly resolve: (result: HighlightResult) => void;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly ready: ReturnType<typeof signal<boolean>>;
  private worker: Worker | null = null;
  private seq = 0;

  readonly available: Signal<boolean>;

  constructor(private readonly createWorker: () => Worker | null) {
    this.ready = signal(false);
    this.available = this.ready.asReadonly();
    this.start();
  }

  request(id: string, code: string): Promise<HighlightResult> {
    if (!this.worker || !fitsCaps(code)) {
      return Promise.resolve(PLAIN);
    }
    const seq = ++this.seq;
    const message: HighlightRequest = { seq, id, code };
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.restart(), REQUEST_DEADLINE_MS);
      this.pending.set(seq, { resolve, timer });
      this.worker?.postMessage(message);
    });
  }

  private start(): void {
    this.worker = this.createWorker();
    this.ready.set(this.worker !== null);
    if (this.worker) {
      this.worker.onmessage = ({ data }: MessageEvent<HighlightReply>) => {
        const entry = this.pending.get(data.seq);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(data.seq);
        entry.resolve(data.result);
      };
      this.worker.onerror = () => this.stop();
    }
  }

  private settleAll(): void {
    for (const { resolve, timer } of this.pending.values()) {
      clearTimeout(timer);
      resolve(PLAIN);
    }
    this.pending.clear();
  }

  private restart(): void {
    this.worker?.terminate();
    this.settleAll();
    this.start();
  }

  private stop(): void {
    this.worker?.terminate();
    this.worker = null;
    this.ready.set(false);
    this.settleAll();
  }
}
