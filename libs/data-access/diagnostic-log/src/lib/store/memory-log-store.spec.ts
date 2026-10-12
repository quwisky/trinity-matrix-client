import { describe, expect, it } from 'vitest';
import type { DiagnosticEntry } from '../diagnostic-entry.model';
import { MemoryLogStore, evictEntries } from './diagnostic-log-store';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 11, 12);

function entry(ts: number, message = 'line'): DiagnosticEntry {
  return { ts, level: 'debug', source: 'sdk', logger: 'matrix', message };
}

describe('evictEntries', () => {
  it('drops entries older than 48 hours, oldest first', () => {
    const old = entry(NOW - 49 * HOUR, 'old');
    const recent = entry(NOW - HOUR, 'recent');

    const { kept, dropped } = evictEntries([old, recent], NOW, {
      maxBytes: 1_000_000,
      maxAgeMs: 48 * HOUR,
    });

    expect(kept).toEqual([recent]);
    expect(dropped).toBe(1);
  });

  it('drops the oldest entries until the rest fit the size cap', () => {
    // Each entry is 100 + 6 + 48 = 154 units; three fit in 500, four do not.
    const lines = [4, 3, 2, 1].map((n) => entry(NOW - n, 'x'.repeat(100)));

    const { kept, dropped } = evictEntries(lines, NOW, {
      maxBytes: 500,
      maxAgeMs: 48 * HOUR,
    });

    expect(kept).toEqual(lines.slice(1));
    expect(dropped).toBe(1);
  });
});

describe('MemoryLogStore', () => {
  it('keeps appended entries in order and reports nothing dropped', async () => {
    const store = new MemoryLogStore();
    await store.append([entry(NOW - 2)], NOW);
    await store.append([entry(NOW - 1)], NOW);

    expect(await store.read()).toEqual({
      entries: [entry(NOW - 2), entry(NOW - 1)],
      dropped: false,
    });
  });

  it('evicts when a batch is written and remembers that it did', async () => {
    const store = new MemoryLogStore({ maxBytes: 1_000_000, maxAgeMs: HOUR });
    await store.append([entry(NOW - 2 * HOUR)], NOW - 2 * HOUR);
    await store.append([entry(NOW)], NOW);

    expect(await store.read()).toEqual({
      entries: [entry(NOW)],
      dropped: true,
    });
  });

  it('clear empties the store and forgets earlier drops', async () => {
    const store = new MemoryLogStore({ maxBytes: 1_000_000, maxAgeMs: HOUR });
    await store.append([entry(NOW - 2 * HOUR), entry(NOW)], NOW);

    await store.clear();

    expect(await store.read()).toEqual({ entries: [], dropped: false });
  });
});
