import {
  type DeviceId,
  Migration,
  OlmMachine,
  StoreHandle,
  type UserId,
} from '@matrix-org/matrix-sdk-crypto-wasm-real';

import { CallQueue, DEFAULT_MAX_BATCH_LENGTH } from './call-queue';
import { NativeOlmMachine, NativeStoreHandle } from './machine';
import type { NativeCryptoOptions } from './types';

const STORE_KEY_LENGTH = 32;

const refuse = (message: string) => async (): Promise<never> => {
  throw new Error(`native crypto: ${message}`);
};

/** The static factories matrix-js-sdk reaches, as the shim answers them. */
function factories(options: NativeCryptoOptions) {
  const context = {
    queue: new CallQueue(
      options.bridge,
      options.maxBatchLength ?? DEFAULT_MAX_BATCH_LENGTH,
      options.logger,
    ),
    logger: options.logger,
    onEventsDropped: options.onEventsDropped,
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

/**
 * Points the real WASM classes' static factories at the native crate. The objects they then
 * return stand in for the WASM classes (`instanceof` holds); every other export stays WASM.
 * Returns the uninstaller, which restores the original factories.
 */
export function install(options: NativeCryptoOptions): () => void {
  if (installed) throw new Error('native crypto is installed already');
  installed = true;
  const replacements = factories(options);
  const originals: [object, string, PropertyDescriptor][] = [];
  for (const [name, target] of Object.entries(TARGETS)) {
    for (const [member, replacement] of Object.entries(
      replacements[name as keyof typeof TARGETS],
    )) {
      const descriptor = Object.getOwnPropertyDescriptor(target, member);
      if (!descriptor)
        throw new Error(
          `native crypto: ${name}.${member} is not in the WASM package`,
        );
      originals.push([target, member, descriptor]);
      Object.defineProperty(target, member, {
        ...descriptor,
        value: replacement,
      });
    }
  }
  return () => {
    if (originals.length === 0) return;
    for (const [target, member, descriptor] of originals.splice(0)) {
      Object.defineProperty(target, member, descriptor);
    }
    installed = false;
  };
}
