import {
  type DeviceId,
  Migration,
  OlmMachine,
  StoreHandle,
  type UserId,
} from '@matrix-org/matrix-sdk-crypto-wasm-real';

import { CallQueue } from './call-queue';
import { NativeOlmMachine, NativeStoreHandle } from './machine';
import type { NativeCryptoOptions } from './types';

const STORE_KEY_LENGTH = 32;

const refuse = (message: string) => async (): Promise<never> => {
  throw new Error(`native crypto: ${message}`);
};

/** The static factories matrix-js-sdk reaches, as the shim answers them. */
function factories(options: NativeCryptoOptions) {
  const context = {
    queue: new CallQueue(options.bridge, options),
    logger: options.logger,
    onEventsDropped: options.onEventsDropped,
    onMachineLost: options.onMachineLost,
  };
  const memory = async (storeName: string | null | undefined) => {
    if (storeName) {
      throw new Error(
        'native crypto: StoreHandle.open with a store name is not supported; open the store with a key (StoreHandle.openWithKey)',
      );
    }
    return new NativeStoreHandle();
  };
  const openWithKey = async (storeName: string, storeKey: Uint8Array) => {
    if (!options.storeDirectory)
      throw new Error('native crypto: no store directory is configured');
    if (!storeName)
      throw new Error(
        'native crypto: StoreHandle.openWithKey needs a store name',
      );
    if (storeKey.length !== STORE_KEY_LENGTH) {
      throw new Error(
        `native crypto: the store key must be ${STORE_KEY_LENGTH} bytes`,
      );
    }
    return new NativeStoreHandle({
      storePath: `${options.storeDirectory}/${encodeURIComponent(storeName)}`,
      storeKey: btoa(String.fromCharCode(...storeKey)),
    });
  };
  const initFromStore = async (
    userId: UserId,
    deviceId: DeviceId,
    store: StoreHandle,
    ...rest: unknown[]
  ) => {
    if (!(store instanceof NativeStoreHandle)) {
      throw new Error(
        'native crypto: OlmMachine.initFromStore needs a store handle opened by the native shim',
      );
    }
    // `logger` (rest[0]) is WASM's tracing sink; the crate logs on its own side.
    if (rest.slice(1).some((value) => value !== undefined)) {
      throw new Error('native crypto: X.509 identity signing is not supported');
    }
    return NativeOlmMachine.init(context, userId, deviceId, store);
  };
  const initialize = async (
    userId: UserId,
    deviceId: DeviceId,
    storeName?: string,
    ...rest: unknown[]
  ) =>
    initFromStore(
      userId,
      deviceId,
      (await memory(storeName)) as unknown as StoreHandle,
      ...rest.slice(1),
    );
  const migration = refuse(
    'legacy libolm migration is not supported on native',
  );
  return {
    StoreHandle: { open: memory, openWithKey },
    OlmMachine: { initFromStore, initialize },
    Migration: {
      migrateBaseData: migration,
      migrateOlmSessions: migration,
      migrateMegolmSessions: migration,
    },
  };
}

const TARGETS = { StoreHandle, OlmMachine, Migration } as const;

/** The static members the shim replaces, by class: what the manifest's statics resolve to. */
export const SHIM_STATICS: Readonly<
  Record<keyof typeof TARGETS, readonly string[]>
> = {
  StoreHandle: ['open', 'openWithKey'],
  OlmMachine: ['initFromStore', 'initialize'],
  Migration: ['migrateBaseData', 'migrateOlmSessions', 'migrateMegolmSessions'],
};

let installed = false;

/** What `install` returns. Uninstalling is for tests: see `uninstallForTests`. */
export interface NativeCryptoInstallation {
  /**
   * Restores the WASM factories. Machines made before keep running on the crate, and the next
   * `initRustCrypto` runs on WASM: two backends in one process, which only a test may want.
   */
  uninstallForTests(): void;
}

/**
 * Points the real WASM classes' static factories at the native crate. The objects they then
 * return stand in for the WASM classes (`instanceof` holds); every other export stays WASM.
 * Install before anything initialises crypto: a WASM machine made earlier stays on WASM.
 */
export function install(
  options: NativeCryptoOptions,
  targets: typeof TARGETS = TARGETS,
): NativeCryptoInstallation {
  if (installed) throw new Error('native crypto is installed already');
  const replacements = factories(options);
  const changes = Object.entries(replacements).flatMap(([name, members]) =>
    Object.entries(members).map(([member, replacement]) => {
      const target: object = targets[name as keyof typeof TARGETS];
      const descriptor = Object.getOwnPropertyDescriptor(target, member);
      if (!descriptor) {
        throw new Error(
          `native crypto: ${name}.${member} is not in the WASM package`,
        );
      }
      return { target, member, descriptor, replacement };
    }),
  );
  for (const { target, member, descriptor, replacement } of changes) {
    Object.defineProperty(target, member, {
      ...descriptor,
      value: replacement,
    });
  }
  installed = true;
  let restored = false;
  return {
    uninstallForTests: () => {
      if (restored) return;
      restored = true;
      for (const { target, member, descriptor } of changes) {
        Object.defineProperty(target, member, descriptor);
      }
      installed = false;
    },
  };
}
