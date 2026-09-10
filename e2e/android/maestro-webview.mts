import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import {
  openDevtoolsConnection,
  type DevtoolsConnection,
} from '../support/devtools-connection.mts';
import type { MaestroDevice } from './maestro-session.mts';

export interface MaestroWebview {
  readonly pid: string;
  readonly diagnostics: DevtoolsConnection;
  close(): Promise<void>;
}

export interface MaestroWebviewOptions {
  readonly applicationId?: 'eu.qwky.trinity' | 'eu.qwky.trinity.secondary';
  readonly readinessTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
  readonly fetch?: (
    input: string,
    init?: { readonly signal?: AbortSignal },
  ) => Promise<{ json(): Promise<unknown> }>;
  readonly connect?: typeof openDevtoolsConnection;
}

interface DevtoolsTarget {
  readonly type?: unknown;
  readonly title?: unknown;
  readonly url?: unknown;
  readonly description?: unknown;
  readonly webSocketDebuggerUrl?: unknown;
}

function parseDescription(value: unknown): {
  readonly visible?: unknown;
  readonly empty?: unknown;
} {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as { readonly visible?: unknown; readonly empty?: unknown })
        : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && value !== null
    ? (value as { readonly visible?: unknown; readonly empty?: unknown })
    : {};
}

function targetsFrom(value: unknown): DevtoolsTarget[] {
  return Array.isArray(value)
    ? value.filter(
        (target): target is DevtoolsTarget =>
          typeof target === 'object' && target !== null,
      )
    : [];
}

function selectTarget(value: unknown): DevtoolsTarget | undefined {
  const candidates = targetsFrom(value).filter((target) => {
    const description = parseDescription(target.description);
    return (
      target.type === 'page' &&
      typeof target.url === 'string' &&
      target.url.startsWith('https://localhost/') &&
      description.visible === true &&
      description.empty === false &&
      // Even a laid-out startup document can be replaced on initial navigation.
      // Bind the test TLS exception only after the app HTML has loaded.
      target.title === 'Trinity'
    );
  });
  if (candidates.length > 1) {
    throw new Error(
      `Expected one visible Trinity WebView target; found ${candidates.length}`,
    );
  }
  return candidates[0];
}

function websocketEndpoint(
  target: DevtoolsTarget | undefined,
): string | undefined {
  return typeof target?.webSocketDebuggerUrl === 'string'
    ? target.webSocketDebuggerUrl
    : undefined;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Android WebView attachment cancelled');
}

function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  lateCleanup: (value: T) => void,
): Promise<T> {
  if (signal.aborted) {
    void operation.then(lateCleanup, () => undefined);
    return Promise.reject(abortError(signal));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => {
        if (settled) {
          lateCleanup(value);
          return;
        }
        settled = true;
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function isTransientMissingProcess(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 1 &&
    'stdout' in error &&
    error.stdout === '' &&
    'stderr' in error &&
    error.stderr === ''
  );
}

/** Observe the installed WebView through raw CDP; Maestro remains native input owner. */
export async function openMaestroWebview(
  device: MaestroDevice,
  options: MaestroWebviewOptions = {},
): Promise<MaestroWebview> {
  const attachController = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, attachController.signal])
    : attachController.signal;
  signal.throwIfAborted();
  const readinessSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(options.readinessTimeoutMs ?? 30_000),
  ]);
  let port: string | undefined;
  let diagnostics: DevtoolsConnection | undefined;
  let closing: Promise<void> | undefined;
  let forwarding: Promise<void> | undefined;
  const deadline = Date.now() + (options.readinessTimeoutMs ?? 30_000);
  const removeForward = async (): Promise<void> => {
    const allocated = port;
    port = undefined;
    if (allocated) await device.removeForward(`tcp:${allocated}`);
  };
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      attachController.abort(new Error('Android WebView closed during attach'));
      const failures: unknown[] = [];
      try {
        diagnostics?.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        // Allocation can complete after cancellation. Its promise also owns
        // removal of any late forward, so cleanup must observe that result.
        if (forwarding)
          await abortable(
            forwarding,
            AbortSignal.timeout(2_000),
            () => undefined,
          );
      } catch (error) {
        failures.push(error);
      }
      try {
        await removeForward();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length)
        throw new AggregateError(
          failures,
          'Android WebView diagnostic cleanup failed',
        );
    })());

  try {
    const applicationId = options.applicationId ?? 'eu.qwky.trinity';
    let pid = '';
    while (Date.now() < deadline && !pid) {
      readinessSignal.throwIfAborted();
      try {
        pid = (
          await abortable(
            device.adb('shell', 'pidof', applicationId),
            readinessSignal,
            () => undefined,
          )
        ).trim();
      } catch (error) {
        readinessSignal.throwIfAborted();
        if (!isTransientMissingProcess(error)) throw error;
      }
      if (!pid) {
        await delay(
          Math.min(
            options.pollIntervalMs ?? 100,
            Math.max(0, deadline - Date.now()),
          ),
          undefined,
          { signal: readinessSignal },
        );
      }
    }
    assert(
      /^\d+$/.test(pid),
      `Trinity process did not become ready: ${applicationId}`,
    );
    readinessSignal.throwIfAborted();
    const socket = `localabstract:webview_devtools_remote_${pid}`;
    forwarding = device.adb('forward', 'tcp:0', socket).then(async (value) => {
      const allocated = value.trim();
      assert(
        /^\d+$/.test(allocated),
        'ADB must allocate a diagnostic forward port',
      );
      port = allocated;
      if (signal.aborted) await removeForward();
    });
    await abortable(forwarding, readinessSignal, () => undefined);
    const fetchJson =
      options.fetch ??
      ((input: string, init?: { readonly signal?: AbortSignal }) =>
        fetch(input, {
          signal: AbortSignal.any([
            init?.signal ?? signal,
            AbortSignal.timeout(2_000),
          ]),
        }));
    const connect = options.connect ?? openDevtoolsConnection;
    let endpoint: string | undefined;
    let lastReadError: unknown;
    while (Date.now() < deadline && !endpoint) {
      let targets: unknown;
      try {
        targets = await abortable(
          fetchJson(`http://127.0.0.1:${port}/json`, {
            signal: readinessSignal,
          }).then((response) => response.json()),
          readinessSignal,
          () => undefined,
        );
      } catch (error) {
        readinessSignal.throwIfAborted();
        lastReadError = error;
      }
      endpoint = websocketEndpoint(selectTarget(targets));
      if (!endpoint)
        await delay(
          Math.min(
            options.pollIntervalMs ?? 100,
            Math.max(0, deadline - Date.now()),
          ),
          undefined,
          { signal: readinessSignal },
        );
    }
    assert(
      endpoint,
      `Android WebView did not publish a visible DevTools target: ${String(lastReadError ?? 'no matching page')}`,
    );
    diagnostics = await abortable(
      connect(endpoint, { signal, timeoutMs: 5_000 }),
      readinessSignal,
      (lateConnection) => lateConnection.close(abortError(signal)),
    );
    // Keep the owned Synapse TLS exception live through native login/callback exchange.
    await abortable(
      diagnostics.send('Security.setIgnoreCertificateErrors', {
        ignore: true,
      }),
      readinessSignal,
      () => undefined,
    );
    return { pid, diagnostics, close };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        'WebView attach and cleanup failed',
      );
    }
    throw error;
  }
}
