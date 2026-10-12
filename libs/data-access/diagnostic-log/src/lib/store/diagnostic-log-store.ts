import {
  DIAGNOSTIC_LOG_LIMITS,
  entrySize,
  type DiagnosticEntry,
  type DiagnosticLogLimits,
} from '../diagnostic-entry.model';

/** Where the log is kept: on disk, or in memory when IndexedDB is unusable. */
export type DiagnosticStorageKind = 'indexeddb' | 'memory';

/** Everything a store holds, oldest first. */
export interface DiagnosticStoreSnapshot {
  readonly entries: readonly DiagnosticEntry[];
  /** True when the cap or the age limit removed entries since the last clear. */
  readonly dropped: boolean;
}

/** A store snapshot plus where it came from, for the export header. */
export interface DiagnosticSnapshot extends DiagnosticStoreSnapshot {
  readonly storage: DiagnosticStorageKind;
}

/** The rolling log's backing store. Eviction runs inside `append`. */
export interface DiagnosticLogStore {
  readonly kind: DiagnosticStorageKind;
  append(entries: readonly DiagnosticEntry[], now: number): Promise<void>;
  read(): Promise<DiagnosticStoreSnapshot>;
  clear(): Promise<void>;
}

/**
 * The entries to keep after expiry and the size cap, oldest dropped first. Entries are in
 * the order they were recorded, which is time order.
 */
export function evictEntries(
  entries: readonly DiagnosticEntry[],
  now: number,
  limits: DiagnosticLogLimits,
): { readonly kept: readonly DiagnosticEntry[]; readonly dropped: number } {
  const cutoff = now - limits.maxAgeMs;
  let start = 0;
  while (start < entries.length && entries[start].ts < cutoff) {
    start += 1;
  }
  let total = 0;
  for (let index = start; index < entries.length; index += 1) {
    total += entrySize(entries[index]);
  }
  while (start < entries.length && total > limits.maxBytes) {
    total -= entrySize(entries[start]);
    start += 1;
  }
  return { kept: start === 0 ? entries : entries.slice(start), dropped: start };
}

/** The fallback when IndexedDB is unusable: the same caps, gone when the page goes. */
export class MemoryLogStore implements DiagnosticLogStore {
  private entries: readonly DiagnosticEntry[] = [];
  private dropped = false;

  readonly kind = 'memory';

  constructor(
    private readonly limits: DiagnosticLogLimits = DIAGNOSTIC_LOG_LIMITS,
  ) {}

  async append(
    entries: readonly DiagnosticEntry[],
    now: number,
  ): Promise<void> {
    const { kept, dropped } = evictEntries(
      [...this.entries, ...entries],
      now,
      this.limits,
    );
    this.entries = kept;
    this.dropped ||= dropped > 0;
  }

  async read(): Promise<DiagnosticStoreSnapshot> {
    return { entries: this.entries, dropped: this.dropped };
  }

  async clear(): Promise<void> {
    this.entries = [];
    this.dropped = false;
  }
}
