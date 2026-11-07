import { IndexedDBStoreWorker } from 'matrix-js-sdk/lib/indexeddb-worker';

import { relaySyncStoreCommands } from './sync-store-relay';

const post = (message: unknown): void => self.postMessage(message);
self.onmessage = relaySyncStoreCommands(new IndexedDBStoreWorker(post), post);
