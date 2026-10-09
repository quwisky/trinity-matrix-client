/**
 * IndexedDB holder for the web wrapping keys of {@link CryptoStoreKeyService}: one
 * non-extractable AES-GCM `CryptoKey` per account. IndexedDB is the one browser store that
 * keeps a `CryptoKey` object without exporting its bytes, which is what keeps the raw key
 * out of script-readable storage.
 */

/** The database name, also named explicitly by the factory reset. */
export const WRAPPING_KEY_DB_NAME = 'trinity-crypto-store-keys';
const STORE = 'wrapping-keys';

/**
 * Open the database. Only a save may create it: a read or delete of a database that does
 * not exist aborts the creation and finds nothing (null). Otherwise removing an account's
 * key after the factory reset deleted every database would bring this one back.
 */
function open(create: boolean): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(WRAPPING_KEY_DB_NAME, 1);
    let absent = false;
    request.onupgradeneeded = () => {
      if (create) {
        request.result.createObjectStore(STORE);
        return;
      }
      absent = true;
      request.transaction?.abort();
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => (absent ? resolve(null) : reject(request.error));
  });
}

async function run<T>(
  create: boolean,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | undefined> {
  const db = await open(create);
  if (!db) {
    return undefined;
  }
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = operation(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

export function loadWrappingKey(id: string): Promise<CryptoKey | undefined> {
  return run(
    false,
    'readonly',
    (store) => store.get(id) as IDBRequest<CryptoKey>,
  );
}

export async function saveWrappingKey(
  id: string,
  key: CryptoKey,
): Promise<void> {
  await run(true, 'readwrite', (store) => store.put(key, id));
}

export async function deleteWrappingKey(id: string): Promise<void> {
  await run(false, 'readwrite', (store) => store.delete(id));
}
