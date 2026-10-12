import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiagnosticEntry } from './diagnostic-entry.model';
import {
  DiagnosticLogRecorder,
  FLUSH_DELAY_MS,
} from './diagnostic-log-recorder';
import {
  MemoryLogStore,
  type DiagnosticLogStore,
} from './store/diagnostic-log-store';

function entry(message: string, ts = Date.now()): DiagnosticEntry {
  return { ts, level: 'debug', source: 'sdk', logger: 'matrix', message };
}

describe('DiagnosticLogRecorder', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds entries in memory until the 5-second flush, then writes them in one batch', async () => {
    const store = new MemoryLogStore();
    const append = vi.spyOn(store, 'append');
    const recorder = new DiagnosticLogRecorder({
      openStore: () => Promise.resolve(store),
    });

    recorder.record(entry('one'));
    recorder.record(entry('two'));
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS - 1);
    expect(append).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(append).toHaveBeenCalledOnce();
    expect(append.mock.calls[0][0].map((e) => e.message)).toEqual([
      'one',
      'two',
    ]);
  });

  it('writes straight away when asked to flush, as on page hide', async () => {
    const store = new MemoryLogStore();
    const recorder = new DiagnosticLogRecorder({
      openStore: () => Promise.resolve(store),
    });

    recorder.record(entry('before hide'));
    await recorder.flush();

    expect((await store.read()).entries.map((e) => e.message)).toEqual([
      'before hide',
    ]);
  });

  it('exports what was recorded but not yet flushed', async () => {
    const recorder = new DiagnosticLogRecorder({
      openStore: () => Promise.resolve(new MemoryLogStore()),
    });

    recorder.record(entry('last second'));
    const snapshot = await recorder.snapshot();

    expect(snapshot.entries.map((e) => e.message)).toEqual(['last second']);
  });

  it('falls back to memory when the store cannot be opened, and says so', async () => {
    const onStorage = vi.fn();
    const recorder = new DiagnosticLogRecorder({
      openStore: () => Promise.reject(new Error('private browsing')),
      onStorage,
    });

    recorder.record(entry('kept anyway'));
    const snapshot = await recorder.snapshot();

    expect(snapshot.storage).toBe('memory');
    expect(snapshot.entries.map((e) => e.message)).toEqual(['kept anyway']);
    expect(onStorage).toHaveBeenCalledWith('memory');
  });

  it('falls back to memory when a write fails, keeping what was stored and the batch', async () => {
    const failing: DiagnosticLogStore = {
      kind: 'indexeddb',
      append: vi.fn(() => Promise.reject(new Error('QuotaExceededError'))),
      read: vi.fn(() =>
        Promise.resolve({ entries: [entry('stored earlier')], dropped: false }),
      ),
      clear: vi.fn(() => Promise.resolve()),
    };
    const onStorage = vi.fn();
    const recorder = new DiagnosticLogRecorder({
      openStore: () => Promise.resolve(failing),
      onStorage,
    });

    recorder.record(entry('refused'));
    const snapshot = await recorder.snapshot();

    expect(snapshot.storage).toBe('memory');
    expect(snapshot.entries.map((e) => e.message)).toEqual([
      'stored earlier',
      'refused',
    ]);
    expect(onStorage).toHaveBeenLastCalledWith('memory');
  });

  it('bounds the unflushed buffer and reports the drop', async () => {
    const recorder = new DiagnosticLogRecorder({
      openStore: () => Promise.resolve(new MemoryLogStore()),
      limits: { maxBytes: 500, maxAgeMs: 60_000 },
    });

    for (let n = 0; n < 10; n += 1) {
      recorder.record(entry('x'.repeat(100)));
    }
    const snapshot = await recorder.snapshot();

    expect(snapshot.entries).toHaveLength(3);
    expect(snapshot.dropped).toBe(true);
  });

  it('clear empties the store and the unflushed buffer', async () => {
    const store = new MemoryLogStore();
    const recorder = new DiagnosticLogRecorder({
      openStore: () => Promise.resolve(store),
    });
    recorder.record(entry('flushed'));
    await recorder.flush();
    recorder.record(entry('pending'));

    await recorder.clear();

    expect((await recorder.snapshot()).entries).toEqual([]);
  });

  it('clear deletes the database when it cannot be opened, rather than only the memory copy', async () => {
    const removeStore = vi.fn(() => Promise.resolve());
    const recorder = new DiagnosticLogRecorder({
      openStore: () => Promise.reject(new Error('IndexedDB open timed out')),
      removeStore,
    });
    recorder.record(entry('in memory'));
    await recorder.flush();

    await recorder.clear();

    expect(removeStore).toHaveBeenCalledOnce();
    expect((await recorder.snapshot()).entries).toEqual([]);
  });

  it('clear fails when the database can neither be opened nor deleted', async () => {
    const recorder = new DiagnosticLogRecorder({
      openStore: () => Promise.reject(new Error('IndexedDB open timed out')),
      removeStore: () => Promise.reject(new Error('delete blocked')),
    });
    recorder.record(entry('in memory'));
    await recorder.flush();

    await expect(recorder.clear()).rejects.toThrow('delete blocked');
  });

  it('clear deletes the database when emptying it fails', async () => {
    const disk = new MemoryLogStore();
    vi.spyOn(disk, 'clear').mockRejectedValue(new Error('read-only'));
    const removeStore = vi.fn(() => Promise.resolve());
    const recorder = new DiagnosticLogRecorder({
      openStore: () => Promise.resolve(disk),
      removeStore,
    });
    recorder.record(entry('flushed'));
    await recorder.flush();

    await recorder.clear();

    expect(removeStore).toHaveBeenCalledOnce();
  });

  it('discard does not count the memory fallback as the stored log', async () => {
    // Writes failed, so capture moved to memory; the database still holds the old log.
    const disk: DiagnosticLogStore = {
      kind: 'indexeddb',
      append: vi.fn(() => Promise.reject(new Error('QuotaExceededError'))),
      read: vi.fn(() => Promise.resolve({ entries: [], dropped: false })),
      clear: vi.fn(() => Promise.reject(new Error('read-only'))),
    };
    const recorder = new DiagnosticLogRecorder({
      openStore: () => Promise.resolve(disk),
      removeStore: () => Promise.reject(new Error('delete blocked')),
    });
    recorder.record(entry('refused'));
    await recorder.flush();

    await expect(recorder.discard()).rejects.toThrow('delete blocked');
    expect(disk.clear).toHaveBeenCalled();
  });

  it('discard drops the batch, removes the store and opens a fresh one next time', async () => {
    const first = new MemoryLogStore();
    const second = new MemoryLogStore();
    const openStore = vi
      .fn<() => Promise<DiagnosticLogStore>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const removeStore = vi.fn(() => first.clear());
    const recorder = new DiagnosticLogRecorder({ openStore, removeStore });
    recorder.record(entry('flushed'));
    await recorder.flush();
    recorder.record(entry('pending'));

    await recorder.discard();
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);

    expect(removeStore).toHaveBeenCalledOnce();
    expect((await first.read()).entries).toEqual([]);
    recorder.record(entry('fresh'));
    expect((await recorder.snapshot()).entries.map((e) => e.message)).toEqual([
      'fresh',
    ]);
    expect(openStore).toHaveBeenCalledTimes(2);
  });

  it('keeps a line recorded straight after discard, for the fresh store', async () => {
    // "Keep a diagnostic log" turned off and on again in one go: the "turned on" marker is
    // recorded before the queued removal runs and must survive it.
    const first = new MemoryLogStore();
    const second = new MemoryLogStore();
    const openStore = vi
      .fn<() => Promise<DiagnosticLogStore>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const recorder = new DiagnosticLogRecorder({
      openStore,
      removeStore: () => first.clear(),
    });
    recorder.record(entry('old'));
    await recorder.flush();

    const discarded = recorder.discard();
    recorder.record(entry('turned on again'));
    await discarded;
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);

    expect((await first.read()).entries).toEqual([]);
    expect((await second.read()).entries.map((e) => e.message)).toEqual([
      'turned on again',
    ]);
  });

  it('discard empties the store when it cannot be removed', async () => {
    const store = new MemoryLogStore();
    const recorder = new DiagnosticLogRecorder({
      openStore: () => Promise.resolve(store),
      removeStore: () => Promise.reject(new Error('blocked')),
    });
    recorder.record(entry('flushed'));
    await recorder.flush();

    await recorder.discard();

    expect((await store.read()).entries).toEqual([]);
  });

  it('discard empties a store that was never opened this session when removal fails', async () => {
    const earlier = new MemoryLogStore();
    await earlier.append([entry('from last session')], Date.now());
    const recorder = new DiagnosticLogRecorder({
      openStore: () => Promise.resolve(earlier),
      removeStore: () => Promise.reject(new Error('blocked')),
    });

    await recorder.discard();

    expect((await earlier.read()).entries).toEqual([]);
  });

  it('discard rejects when the log can neither be removed nor emptied', async () => {
    const recorder = new DiagnosticLogRecorder({
      openStore: () => Promise.reject(new Error('unavailable')),
      removeStore: () => Promise.reject(new Error('blocked')),
    });

    await expect(recorder.discard()).rejects.toThrow('blocked');
  });

  it('trims entries past the age limit from the unflushed buffer when it overflows', async () => {
    const recorder = new DiagnosticLogRecorder({
      openStore: () => Promise.resolve(new MemoryLogStore()),
      limits: { maxBytes: 500, maxAgeMs: 60_000 },
    });
    const stale = Date.now() - 120_000;

    recorder.record(entry('a'.repeat(100), stale));
    recorder.record(entry('b'.repeat(100), stale));
    recorder.record(entry('c'.repeat(100)));
    recorder.record(entry('d'.repeat(100)));
    const snapshot = await recorder.snapshot();

    expect(snapshot.entries.map((e) => e.message[0])).toEqual(['c', 'd']);
    expect(snapshot.dropped).toBe(true);
  });
});
