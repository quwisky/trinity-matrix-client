import { IndexedDBStoreWorker } from 'matrix-js-sdk/lib/indexeddb-worker';

const store = new IndexedDBStoreWorker((message) => self.postMessage(message));
self.onmessage = store.onMessage;
