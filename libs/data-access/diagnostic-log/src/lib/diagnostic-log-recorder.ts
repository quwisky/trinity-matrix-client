import {
  DIAGNOSTIC_LOG_LIMITS,
  entrySize,
  type DiagnosticEntry,
  type DiagnosticLogLimits,
} from './diagnostic-entry.model';
import {
  MemoryLogStore,
  evictEntries,
  type DiagnosticLogStore,
  type DiagnosticSnapshot,
  type DiagnosticStorageKind,
  type DiagnosticStoreSnapshot,
} from './store/diagnostic-log-store';

/** How long entries wait in memory before a batch is written (spec §1). */
export const FLUSH_DELAY_MS = 5_000;

export interface DiagnosticLogRecorderOptions {
  /** Opens the persistent store. A rejection moves capture to memory. */
  readonly openStore: () => Promise<DiagnosticLogStore>;
  /** Deletes the persistent store, for {@link DiagnosticLogRecorder.discard}. */
  readonly removeStore?: () => Promise<void>;
  /** Told which store capture ended up using, and again if it falls back. */
  readonly onStorage?: (kind: DiagnosticStorageKind) => void;
  readonly limits?: DiagnosticLogLimits;
  readonly flushDelayMs?: number;
  readonly now?: () => number;
}

/**
 * Batches entries and writes them to the store. The store is opened lazily by the first
 * flush, so start-up pays nothing but a timer; the first write happens after first render.
 * Every store operation runs through one queue, so a flush, a snapshot and a clear never
 * interleave.
 */
export class DiagnosticLogRecorder {
  private readonly limits: DiagnosticLogLimits;
  private readonly flushDelayMs: number;
  private readonly now: () => number;
  private pending: DiagnosticEntry[] = [];
  private pendingBytes = 0;
  private droppedUnflushed = false;
  private store: DiagnosticLogStore | null = null;
  private opening: Promise<DiagnosticLogStore> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: DiagnosticLogRecorderOptions) {
    this.limits = options.limits ?? DIAGNOSTIC_LOG_LIMITS;
    this.flushDelayMs = options.flushDelayMs ?? FLUSH_DELAY_MS;
    this.now = options.now ?? Date.now;
  }

  record(entry: DiagnosticEntry): void {
    this.pending.push(entry);
    this.pendingBytes += entrySize(entry);
    if (this.pendingBytes > this.limits.maxBytes) {
      this.trimPending();
    }
    this.timer ??= setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.flushDelayMs);
  }

  /** Write the buffer now. */
  flush(): Promise<void> {
    return this.enqueue(() => this.writePending());
  }

  /** Everything stored plus everything still buffered, oldest first. */
  snapshot(): Promise<DiagnosticSnapshot> {
    return this.enqueue(async () => {
      await this.writePending();
      let store = await this.currentStore();
      let stored: DiagnosticStoreSnapshot;
      try {
        stored = await store.read();
      } catch {
        store = await this.fallBack([]);
        stored = await store.read();
      }
      return {
        entries: stored.entries,
        dropped: stored.dropped || this.droppedUnflushed,
        storage: store.kind,
      };
    });
  }

  clear(): Promise<void> {
    return this.enqueue(async () => {
      this.pending = [];
      this.pendingBytes = 0;
      this.droppedUnflushed = false;
      const store = await this.currentStore();
      try {
        await store.clear();
      } catch {
        await (await this.fallBack([])).clear();
      }
    });
  }

  /**
   * Stop and forget, for "Keep a diagnostic log" turned off: cancel the pending write and
   * drop the unflushed batch at once, then delete the store in turn. Dropping the batch
   * before queueing means nothing recorded after this call is lost to the removal: it goes
   * to a fresh store, opened by the next write. Where the store cannot be removed, it is
   * emptied instead.
   */
  discard(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = [];
    this.pendingBytes = 0;
    this.droppedUnflushed = false;
    return this.enqueue(async () => {
      const store = this.store;
      this.store = null;
      this.opening = null;
      if (this.options.removeStore) {
        try {
          await this.options.removeStore();
          return;
        } catch {
          // Fall through and empty what is still there.
        }
      }
      await store?.clear().catch(() => undefined);
    });
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async writePending(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0) {
      return;
    }
    const batch = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    const store = await this.currentStore();
    try {
      await store.append(batch, this.now());
    } catch {
      await this.fallBack(batch);
    }
  }

  private async currentStore(): Promise<DiagnosticLogStore> {
    if (this.store) {
      return this.store;
    }
    this.opening ??= this.options
      .openStore()
      .catch((): DiagnosticLogStore => new MemoryLogStore(this.limits));
    const store = await this.opening;
    if (!this.store) {
      this.store = store;
      this.options.onStorage?.(store.kind);
    }
    return this.store;
  }

  /** Carry on in memory with what the failed store still returns, plus the batch it refused. */
  private async fallBack(
    batch: readonly DiagnosticEntry[],
  ): Promise<DiagnosticLogStore> {
    const failed = this.store;
    if (failed?.kind === 'memory') {
      await failed.append(batch, this.now());
      return failed;
    }
    let carried: readonly DiagnosticEntry[] = [];
    try {
      carried = failed ? (await failed.read()).entries : [];
    } catch {
      carried = [];
    }
    const memory = new MemoryLogStore(this.limits);
    await memory.append([...carried, ...batch], this.now());
    this.store = memory;
    this.options.onStorage?.('memory');
    return memory;
  }

  private trimPending(): void {
    const { kept, dropped } = evictEntries(
      this.pending,
      this.now(),
      this.limits,
    );
    this.pending = [...kept];
    this.pendingBytes = kept.reduce((sum, entry) => sum + entrySize(entry), 0);
    if (dropped > 0) {
      this.droppedUnflushed = true;
    }
  }
}
