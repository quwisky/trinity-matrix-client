import { describe, expect, it, vi } from 'vitest';
import { IndexedDbMentionStore, pageRange } from './indexed-db-mention-store';
import { FakeMentionStore } from './mention-index.spec-harness';
import {
  MENTION_MAX_AGE_MS,
  MENTION_ROW_LIMIT,
  rowsPastLimits,
} from './mention-index-store';

const NOW = 2_000_000_000_000;

function rows(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    ts: NOW - 1_000 + i,
    eventId: `$e${String(i).padStart(5, '0')}`,
  }));
}

describe('rowsPastLimits', () => {
  it('keeps the newest 2,000 rows', () => {
    expect(rowsPastLimits(rows(MENTION_ROW_LIMIT), NOW)).toEqual([]);
    expect(rowsPastLimits(rows(MENTION_ROW_LIMIT + 1), NOW)).toEqual([
      '$e00000',
    ]);
  });

  it('drops rows older than 1 year', () => {
    const edge = NOW - MENTION_MAX_AGE_MS;
    expect(
      rowsPastLimits(
        [
          { ts: edge - 1, eventId: '$old' },
          { ts: edge, eventId: '$edge' },
        ],
        NOW,
      ),
    ).toEqual(['$old']);
  });

  it('breaks a ts tie by eventId', () => {
    const tied = Array.from({ length: MENTION_ROW_LIMIT + 1 }, (_, i) => ({
      ts: NOW,
      eventId: `$t${String(i).padStart(5, '0')}`,
    }));
    expect(rowsPastLimits(tied, NOW)).toEqual(['$t00000']);
    expect(rowsPastLimits([...tied].reverse(), NOW)).toEqual(['$t00000']);
  });
});

/** A fake IDBFactory whose open request fails the way a private window's does. */
function refusingFactory(): IDBFactory {
  return {
    open: () => {
      const request: Record<string, unknown> = {
        error: new DOMException('The operation failed', 'InvalidStateError'),
      };
      queueMicrotask(() =>
        (request['onerror'] as (() => void) | undefined)?.(),
      );
      return request as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
}

function deletingFactory(event: 'onsuccess' | 'onblocked'): IDBFactory {
  return {
    deleteDatabase: () => {
      const request: Record<string, unknown> = {};
      queueMicrotask(() => (request[event] as (() => void) | undefined)?.());
      return request as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
}

describe('IndexedDbMentionStore', () => {
  it('refuses where IndexedDB does not exist', async () => {
    const store = new IndexedDbMentionStore(undefined);
    await expect(store.count()).rejects.toThrow('IndexedDB is unavailable');
    await expect(store.deleteAll()).rejects.toThrow('IndexedDB is unavailable');
  });

  it('rejects when the browser refuses the database', async () => {
    await expect(
      new IndexedDbMentionStore(refusingFactory()).put(
        'a',
        { eventId: '$1', roomId: '!r', ts: NOW },
        NOW,
      ),
    ).rejects.toBeTruthy();
  });

  it('deleteAll resolves once the database is gone', async () => {
    await expect(
      new IndexedDbMentionStore(deletingFactory('onsuccess')).deleteAll(),
    ).resolves.toBeUndefined();
  });

  it('deleteAll rejects unless the database is gone', async () => {
    await expect(
      new IndexedDbMentionStore(deletingFactory('onblocked')).deleteAll(),
    ).rejects.toThrow('mention index not deleted: blocked');
  });
});

describe('FakeMentionStore', () => {
  it('applies the limits on put and pages newest first', async () => {
    const store = new FakeMentionStore();
    for (const r of rows(MENTION_ROW_LIMIT + 1)) {
      await store.put('a', { ...r, roomId: '!r' }, NOW);
    }
    expect(await store.count('a')).toBe(MENTION_ROW_LIMIT);
    const first = await store.page('a', null, 2, NOW);
    expect(first.map((r) => r.eventId)).toEqual(['$e02000', '$e01999']);
    const next = await store.page('a', first[1], 1, NOW);
    expect(next.map((r) => r.eventId)).toEqual(['$e01998']);
  });

  it('fails a put or reads on demand', async () => {
    const store = new FakeMentionStore();
    store.failNextPut(new Error('quota'));
    await expect(
      store.put('a', { eventId: '$1', roomId: '!r', ts: NOW }, NOW),
    ).rejects.toThrow('quota');
    await expect(
      store.put('a', { eventId: '$1', roomId: '!r', ts: NOW }, NOW),
    ).resolves.toBeUndefined();
    store.failReads();
    await expect(store.count()).rejects.toThrow('read failed');
  });
});

describe('pageRange', () => {
  const floor = NOW - MENTION_MAX_AGE_MS;

  it('is null when the cursor lies under the age floor', () => {
    expect(pageRange('a', { ts: floor - 1, eventId: '$x' }, NOW)).toBeNull();
  });

  it('is a range when the cursor is at or above the floor, or absent', () => {
    vi.stubGlobal('IDBKeyRange', { bound: (...args: unknown[]) => args });
    expect(pageRange('a', { ts: floor, eventId: '$x' }, NOW)).not.toBeNull();
    expect(pageRange('a', null, NOW)).not.toBeNull();
    vi.unstubAllGlobals();
  });
});

describe('put validation', () => {
  const bad = [
    { eventId: '$1', roomId: '!r', ts: Number.NaN },
    { eventId: '$1', roomId: '!r', ts: '5' as unknown as number },
    { eventId: '$1', roomId: '!r', ts: undefined as unknown as number },
    { eventId: '', roomId: '!r', ts: NOW },
    { eventId: '$1', roomId: '', ts: NOW },
  ];

  it.each(bad)(
    'rejects %o with a TypeError, before opening the database',
    async (record) => {
      const open = vi.fn();
      const real = new IndexedDbMentionStore({ open } as unknown as IDBFactory);
      await expect(real.put('a', record, NOW)).rejects.toThrow(TypeError);
      expect(open).not.toHaveBeenCalled();
      await expect(
        new FakeMentionStore().put('a', record, NOW),
      ).rejects.toThrow(TypeError);
    },
  );
});
