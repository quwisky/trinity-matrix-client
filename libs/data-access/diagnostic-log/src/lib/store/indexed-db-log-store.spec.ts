import { describe, expect, it } from 'vitest';
import { IndexedDbLogStore, deleteIndexedDbLog } from './indexed-db-log-store';

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

describe('IndexedDbLogStore.open', () => {
  it('refuses where IndexedDB does not exist', async () => {
    await expect(IndexedDbLogStore.open(undefined)).rejects.toThrow(
      'IndexedDB is unavailable',
    );
  });

  it('refuses when the browser rejects the database', async () => {
    await expect(
      IndexedDbLogStore.open(refusingFactory()),
    ).rejects.toBeTruthy();
  });

  it('refuses when open throws', async () => {
    const throwing = {
      open: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    } as unknown as IDBFactory;

    await expect(IndexedDbLogStore.open(throwing)).rejects.toBeTruthy();
  });
});

/** A fake IDBFactory whose deletes succeed (or fail), recording the names asked for. */
function deletingFactory(
  deleted: string[],
  outcome: 'success' | 'error' = 'success',
): IDBFactory {
  return {
    deleteDatabase: (name: string) => {
      deleted.push(name);
      const request: Record<string, unknown> = {};
      queueMicrotask(() =>
        (
          request[outcome === 'success' ? 'onsuccess' : 'onerror'] as
            (() => void) | undefined
        )?.(),
      );
      return request as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
}

describe('deleteIndexedDbLog', () => {
  it('deletes the diagnostic log database by name', async () => {
    const deleted: string[] = [];

    await deleteIndexedDbLog(deletingFactory(deleted));

    expect(deleted).toEqual(['trinity-diagnostic-log']);
  });

  it('rejects when the database was not deleted, and does nothing without IndexedDB', async () => {
    await expect(
      deleteIndexedDbLog(deletingFactory([], 'error')),
    ).rejects.toThrow('diagnostic log not deleted: failed');
    await expect(deleteIndexedDbLog(undefined)).resolves.toBeUndefined();
  });
});
