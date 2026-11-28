import type { NativeCryptoOptions } from './native/types';

export type {
  NativeCryptoBridge,
  NativeCryptoLogger,
  NativeCryptoOptions,
} from './native/types';

/**
 * Runs matrix-js-sdk's crypto on the native crate from now on: the shim loads lazily and
 * patches the WASM package's static factories. Returns the uninstaller.
 */
export async function installNativeCrypto(
  options: NativeCryptoOptions,
): Promise<() => void> {
  const { install } = await import('./native/install');
  return install(options);
}
