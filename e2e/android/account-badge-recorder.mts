import assert from 'node:assert/strict';
import type { AccountWorkspaceClient } from './account-workspace-client.mts';
import { evaluateNative } from './native-shell-client.mts';

export interface AccountBadgeRecorder {
  count(): Promise<number>;
  calls(): Promise<readonly unknown[][]>;
  close(): Promise<void>;
}

const recorderSource = `(() => {
  const w = window;
  const timeOrigin = performance.timeOrigin;
  w.__accountBadgeCalls = [];
  w.__accountBadgeCount = 0;
  w.__accountBadgeRecorderTimeOrigin = timeOrigin;
  const install = () => {
    const capacitor = window.Capacitor;
    const nativePromise = capacitor && capacitor.nativePromise;
    if (!capacitor || !nativePromise) {
      setTimeout(install, 0);
      return;
    }
    if (nativePromise.__accountBadgeWrapped) return;
    const original = nativePromise.bind(capacitor);
    const recordSet = (count) => {
      if (performance.timeOrigin !== timeOrigin) return;
      w.__accountBadgeCount = count;
      w.__accountBadgeCalls.push(['set', count]);
    };
    const recordClear = () => {
      if (performance.timeOrigin !== timeOrigin) return;
      w.__accountBadgeCount = 0;
      w.__accountBadgeCalls.push(['clear']);
    };
    const wrapped = (pluginName, methodName, options = {}) => {
      if (pluginName !== 'Badge') return original(pluginName, methodName, options);
      if (methodName === 'isSupported') return Promise.resolve({ isSupported: true });
      if (methodName === 'requestPermissions' || methodName === 'checkPermissions')
        return Promise.resolve({ display: 'granted' });
      if (methodName === 'set') {
        recordSet(Number(options.count ?? 0));
        return Promise.resolve();
      }
      if (methodName === 'clear') {
        recordClear();
        return Promise.resolve();
      }
      if (methodName === 'get') return Promise.resolve({ count: w.__accountBadgeCount ?? 0 });
      return original(pluginName, methodName, options);
    };
    wrapped.__accountBadgeWrapped = true;
    capacitor.nativePromise = wrapped;
  };
  install();
})();`;

export async function installAccountBadgeRecorder(
  client: AccountWorkspaceClient,
): Promise<AccountBadgeRecorder> {
  const remove = await client.installDocumentScript(recorderSource);
  return {
    count: async () => {
      const count = await evaluateNative(client.webview, 'window.__accountBadgeCount');
      assert(typeof count === 'number', 'Badge recorder count is not numeric');
      return count;
    },
    calls: async () => {
      const calls = await evaluateNative(client.webview, 'window.__accountBadgeCalls');
      assert(Array.isArray(calls), 'Badge recorder calls are not an array');
      return calls as readonly unknown[][];
    },
    close: remove,
  };
}
