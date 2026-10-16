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

/** How long entries wait in memory before a batch is written. */
export const FLUSH_DELAY_MS = 5_000;

/**
 * When the database could not be opened (a slow cold start can exceed the open's time
 * limit), how long to wait before each further try, at the next write after it. Bounded, so
 * a broken store costs at most this many more opens per session.
 */
export const STORE_RETRY_DELAYS_MS: readonly number[] = [
  30_000, 120_000, 600_000,
];

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
 * Batches entries and writes them to the store, opened lazily by the first flush so start-up
 * pays only a timer. Every store operation runs through one queue, so a flush, a snapshot
 * and a clear never interleave.
 */
export class DiagnosticLogRecorder {
  private readonly limits: DiagnosticLogLimits;
  private readonly flushDelayMs: number;
  private readonly now: () => number;
  private pending: DiagnosticEntry[] = [];
  private pendingBytes = 0;
  private droppedUnflushed = false;
  private store: DiagnosticLogStore | null = null;
  /** The store is this recorder's memory fallback, not the one `openStore` gave. */
  private fallenBack = false;
  /** Tries of the database made since it failed to open; all used up after a write failure. */
  private storeRetries = 0;
  private nextStoreRetryAt = 0;
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

  /**
   * Empty the log: the unflushed batch, and the stored log on disk. Where the database can't
   * be opened or emptied it is deleted instead; a memory fallback is emptied too but never
   * counts as the stored log. Rejects when the stored log may still be on disk.
   */
  clear(): Promise<void> {
    return this.enqueue(async () => {
      this.pending = [];
      this.pendingBytes = 0;
      this.droppedUnflushed = false;
      const store = await this.currentStore();
      if (!this.fallenBack) {
        try {
          await store.clear();
          return;
        } catch {
          // Delete the database below instead.
        }
      } else {
        await store.clear();
      }
      await this.removeStoredLog(this.fallenBack ? null : store);
    });
  }

  /**
   * Stop and forget, for "Keep a diagnostic log" turned off: cancel the pending write and
   * drop the unflushed batch at once, then delete the store in turn. Dropping the batch
   * before queueing means nothing recorded after this call is lost to the removal: it goes
   * to a fresh store, opened by the next write. Where the store cannot be removed, it is
   * emptied instead, opening it first if this session never did (an earlier session's log
   * can still be on disk); the memory fallback never counts. Rejects only when the log could
   * be neither removed nor emptied, so the caller can tell the user it is still there.
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
      const disk = this.fallenBack ? null : this.store;
      this.store = null;
      this.opening = null;
      this.fallenBack = false;
      this.storeRetries = 0;
      await this.removeStoredLog(disk);
    });
  }

  /**
   * Delete the database, or else empty it: through `disk` when it is open, otherwise by
   * opening it. Rejects with the removal's error when neither works.
   */
  private async removeStoredLog(
    disk: DiagnosticLogStore | null,
  ): Promise<void> {
    let removal: unknown = new Error('Diagnostic log cannot be removed');
    if (this.options.removeStore) {
      try {
        await this.options.removeStore();
        return;
      } catch (error) {
        removal = error;
      }
    }
    try {
      await (disk ?? (await this.options.openStore())).clear();
    } catch {
      throw removal;
    }
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
    await this.retryStore();
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
    let fallenBack = false;
    this.opening ??= this.options.openStore().catch((): DiagnosticLogStore => {
      fallenBack = true;
      return new MemoryLogStore(this.limits);
    });
    const store = await this.opening;
    if (!this.store) {
      this.store = store;
      this.fallenBack = fallenBack;
      if (fallenBack) {
        this.scheduleStoreRetry();
      }
      this.options.onStorage?.(store.kind);
    }
    return this.store;
  }

  private scheduleStoreRetry(): void {
    this.nextStoreRetryAt =
      this.now() + (STORE_RETRY_DELAYS_MS[this.storeRetries] ?? 0);
  }

  /**
   * Once the back-off has passed, try to open the database again and move what memory holds
   * onto it. Only after a failed open: after a failed write, memory already holds the old
   * stored log, which would then be stored twice.
   */
  private async retryStore(): Promise<void> {
    const memory = this.store;
    if (
      !memory ||
      !this.fallenBack ||
      this.storeRetries >= STORE_RETRY_DELAYS_MS.length ||
      this.now() < this.nextStoreRetryAt
    ) {
      return;
    }
    this.storeRetries += 1;
    let disk: DiagnosticLogStore;
    try {
      disk = await this.options.openStore();
      await disk.append((await memory.read()).entries, this.now());
    } catch {
      this.scheduleStoreRetry();
      return;
    }
    this.store = disk;
    this.fallenBack = false;
    this.options.onStorage?.(disk.kind);
  }

  /** Carry on in memory with what the failed store still returns, plus the batch it refused. */
  private async fallBack(
    batch: readonly DiagnosticEntry[],
  ): Promise<DiagnosticLogStore> {
    const failed = this.store;
    if (failed && this.fallenBack) {
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
    this.fallenBack = true;
    this.storeRetries = STORE_RETRY_DELAYS_MS.length;
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
