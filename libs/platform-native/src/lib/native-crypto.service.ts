import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { type MatrixSession, cryptoBackendFor } from '@trinity/util/matrix';

/** Native end-to-end encryption on this host (see `native-crypto-host.ts`). */
export interface NativeCryptoHost {
  /** Puts every crypto start of this process on the native crate; later calls share it. */
  install(): Promise<void>;
  /** Calls `listener` when this device's machine is lost; returns its removal. */
  onMachineLost(
    userId: string,
    deviceId: string,
    listener: () => void,
  ): () => void;
  /** Closes the device's machine and deletes its store and wrapped key; nothing there is success. */
  deleteStore(userId: string, deviceId: string): Promise<void>;
  /** {@link deleteStore} for each native record, best-effort and bounded. */
  deleteStores(
    records: readonly Pick<
      MatrixSession,
      'userId' | 'deviceId' | 'cryptoBackend'
    >[],
  ): Promise<void>;
}

/** A session's crypto store was made by the other backend; nothing was opened. */
export class CryptoBackendMismatchError extends Error {
  constructor() {
    super(
      'Encryption was set up by another build: sign out and in again on this build.',
    );
  }
}

/**
 * Whether crypto runs natively here: on Android when the build carries the crate's library.
 * Everywhere else (web, Electron, iOS for now, an Android build without the library) the
 * answer is null and crypto runs on WASM. The plugin and the shim load lazily.
 */
@Injectable({ providedIn: 'root' })
export class NativeCryptoService {
  private connection?: Promise<NativeCryptoHost | null>;

  /**
   * The host for a session's store with the shim installed, or null for WASM. Refuses a store
   * of the other backend with {@link CryptoBackendMismatchError}.
   */
  async prepare(
    mark: MatrixSession['cryptoBackend'],
  ): Promise<NativeCryptoHost | null> {
    const host = await this.host();
    const nativeAvailable = host !== null;
    if (
      cryptoBackendFor({ nativeAvailable, mark, newDevice: false }) === 'refuse'
    )
      throw new CryptoBackendMismatchError();
    await host?.install();
    return host;
  }

  /** {@link NativeCryptoHost.deleteStore} where crypto is native; best-effort, never rejects. */
  async deleteStore(userId: string, deviceId: string): Promise<void> {
    await (
      await this.host().catch(() => null)
    )
      ?.deleteStore(userId, deviceId)
      .catch(() => undefined);
  }

  host(): Promise<NativeCryptoHost | null> {
    return (this.connection ??=
      Capacitor.getPlatform() === 'android'
        ? import('./native-crypto-host').then((host) => host.connect())
        : Promise.resolve(null));
  }
}
