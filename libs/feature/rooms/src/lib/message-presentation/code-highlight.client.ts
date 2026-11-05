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

/** The worker begins tokenizing `seq`; loading and queueing time before this does not count. */
export interface HighlightStarted {
  readonly seq: number;
  readonly started: true;
}

/**
 * How long one block may spend being tokenized. Real blocks take a few milliseconds; a grammar
 * that loops on crafted input never answers, and every later block would queue behind it.
 */
export const REQUEST_DEADLINE_MS = 2_000;

const PLAIN: HighlightResult = { kind: 'plain' };
const RETRY: HighlightResult = { kind: 'retry' };

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
 * that runs past its deadline restarts the worker: that block stays plain (the main thread must
 * not run the input that hung it) and the others waiting are retried. After a retry answer it
 * restarts once idle, so a grammar that failed to load is fetched again by a fresh module cache.
 */
export class CodeHighlightClient {
  private readonly pending = new Map<
    number,
    {
      readonly resolve: (result: HighlightResult) => void;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly ready: ReturnType<typeof signal<boolean>>;
  private worker: Worker | null = null;
  private seq = 0;
  /** A grammar failed to load: restart for a fresh module cache once nothing else is waiting. */
  private restartWhenIdle = false;

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
      this.pending.set(seq, { resolve });
      this.worker?.postMessage(message);
    });
  }

  private start(): void {
    this.worker = this.createWorker();
    this.ready.set(this.worker !== null);
    if (this.worker) {
      this.worker.onmessage = ({
        data,
      }: MessageEvent<HighlightReply | HighlightStarted>) => {
        const entry = this.pending.get(data.seq);
        if (!entry) return;
        if ('started' in data) {
          entry.timer = setTimeout(
            () => this.restart(data.seq),
            REQUEST_DEADLINE_MS,
          );
          return;
        }
        clearTimeout(entry.timer);
        this.pending.delete(data.seq);
        entry.resolve(data.result);
        if (data.result.kind === 'retry') this.restartWhenIdle = true;
        if (this.restartWhenIdle && this.pending.size === 0) this.restart(null);
      };
      this.worker.onerror = () => this.stop();
    }
  }

  /** Settle every waiting block: `stuck` (the one that hung, if any) as plain, the rest as `rest`. */
  private settleAll(stuck: number | null, rest: HighlightResult): void {
    for (const [seq, { resolve, timer }] of this.pending) {
      clearTimeout(timer);
      resolve(seq === stuck ? PLAIN : rest);
    }
    this.pending.clear();
  }

  private restart(stuck: number | null): void {
    this.restartWhenIdle = false;
    this.worker?.terminate();
    this.settleAll(stuck, RETRY);
    this.start();
  }

  private stop(): void {
    this.worker?.terminate();
    this.worker = null;
    this.ready.set(false);
    this.settleAll(null, PLAIN);
  }
}
