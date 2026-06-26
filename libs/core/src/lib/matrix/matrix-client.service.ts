import { Injectable, signal, inject } from '@angular/core';
import {
  createClient,
  MatrixClient,
  ClientEvent,
  SyncState,
} from 'matrix-js-sdk';
import { SessionStorageService } from '../storage/session-storage.service';
import { MatrixSession } from './session.model';
import { preloadCryptoWasm } from './crypto-wasm-loader';

/**
 * Owns the single matrix-js-sdk MatrixClient instance and its lifecycle.
 *
 * Lifecycle contract (see PLAN.md / STACK.md):
 *   createClient -> initRustCrypto() -> startClient()
 * The legacy `client.crypto` is gone; use `client.getCrypto()` for the CryptoApi.
 *
 * Components must NOT import matrix-js-sdk directly — go through this service and
 * the feature services (auth, sync, timeline) layered on top.
 */
@Injectable({ providedIn: 'root' })
export class MatrixClientService {
  private readonly storage = inject(SessionStorageService);
  private client: MatrixClient | null = null;

  /** Coarse sync state for the UI (null until the first sync transition). */
  readonly syncState = signal<SyncState | null>(null);

  get instance(): MatrixClient {
    if (!this.client) {
      throw new Error('MatrixClient not initialized — call init() first.');
    }
    return this.client;
  }

  get isInitialized(): boolean {
    return this.client !== null;
  }

  /**
   * Build the client from a session, bootstrap E2EE, and start syncing.
   * E2EE is enabled in MVP, so initRustCrypto() runs before startClient().
   */
  async init(session: MatrixSession): Promise<void> {
    this.client = createClient({
      baseUrl: session.baseUrl,
      accessToken: session.accessToken,
      userId: session.userId,
      deviceId: session.deviceId,
    });

    // Preload the WASM from the served asset path, then init the crypto store
    // (IndexedDB inside browsers/WebViews by default).
    await preloadCryptoWasm();
    await this.client.initRustCrypto();

    this.client.on(ClientEvent.Sync, (state) => this.syncState.set(state));

    await this.client.startClient({ initialSyncLimit: 20 });
  }

  /** Restore a persisted session on app start, if one exists. */
  async restore(): Promise<boolean> {
    const session = await this.storage.load();
    if (!session) {
      return false;
    }
    await this.init(session);
    return true;
  }

  /** Stop syncing and tear down the client (without clearing the session). */
  async stop(): Promise<void> {
    this.client?.stopClient();
    this.client = null;
    this.syncState.set(null);
  }
}
