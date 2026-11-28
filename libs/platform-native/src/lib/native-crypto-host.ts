import { registerPlugin } from '@capacitor/core';
import type { NativeCryptoBridge } from '@trinity/crypto-backend';
import type { NativeCryptoHost } from './native-crypto.service';

interface Machine {
  readonly userId: string;
  readonly deviceId: string;
}

/** The Android plugin (android/app/src/main/java/dev/trinityproject/trinity/crypto). */
interface TrinityCryptoPlugin {
  available(): Promise<{ available: boolean }>;
  call(options: Machine & { request: string }): Promise<{ response: string }>;
  callBatch(
    options: Machine & { requests: string },
  ): Promise<{ response: string }>;
  deleteStore(options: Machine): Promise<void>;
}

/** How long an erase waits for the native stores to be deleted. */
const DELETE_BUDGET_MS = 5000;

const plugin = registerPlugin<TrinityCryptoPlugin>('TrinityCrypto');
const key = ({ userId, deviceId }: Machine) =>
  JSON.stringify([userId, deviceId]);

/** The plugin as the shim's bridge: one thread per machine, stores opened natively. */
export const pluginBridge: NativeCryptoBridge = {
  concurrentMachines: true,
  ownsStores: true,
  call: async (request, { userId, deviceId }) =>
    (await plugin.call({ userId, deviceId, request })).response,
  callBatch: async (requests, { userId, deviceId }) =>
    (await plugin.callBatch({ userId, deviceId, requests })).response,
};

/** The host when the plugin is there and its library loaded; null otherwise (WASM). */
export async function connect(): Promise<NativeCryptoHost | null> {
  const { available } = await plugin
    .available()
    .catch(() => ({ available: false }));
  if (!available) return null;
  const listeners = new Map<string, () => void>();
  let installed: Promise<void> | undefined;
  return {
    install: () =>
      (installed ??= import('@trinity/crypto-backend').then(
        async ({ installNativeCrypto }) => {
          await installNativeCrypto({
            bridge: pluginBridge,
            logger: console,
            onMachineLost: (_reason, machine) =>
              listeners.get(key(machine))?.(),
          });
        },
      )),
    onMachineLost: (userId, deviceId, listener) => {
      const machine = key({ userId, deviceId });
      listeners.set(machine, listener);
      return () => {
        if (listeners.get(machine) === listener) listeners.delete(machine);
      };
    },
    deleteStore: (userId, deviceId) => plugin.deleteStore({ userId, deviceId }),
    deleteStores: async (records) => {
      await Promise.race([
        Promise.allSettled(
          records
            .filter((record) => record.cryptoBackend === 'native')
            .map(({ userId, deviceId }) =>
              plugin.deleteStore({ userId, deviceId }),
            ),
        ),
        new Promise((done) => setTimeout(done, DELETE_BUDGET_MS)),
      ]);
    },
  };
}
