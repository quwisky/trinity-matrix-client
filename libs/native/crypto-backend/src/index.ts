import type { NativeCryptoInstallation } from './native/install';
import type { NativeCryptoOptions } from './native/types';

export type { NativeCryptoInstallation } from './native/install';
export type {
  NativeCryptoBridge,
  NativeCryptoLogger,
  NativeCryptoOptions,
} from './native/types';

/**
 * Runs matrix-js-sdk's crypto on the native crate from now on: the shim loads lazily and
 * patches the WASM package's static factories. Call it before anything initialises crypto,
 * and stop the client when `onMachineLost` fires.
 */
export async function installNativeCrypto(
  options: NativeCryptoOptions,
): Promise<NativeCryptoInstallation> {
  const { install } = await import('./native/install');
  return install(options);
}
