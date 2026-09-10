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
  readonly attached?: unknown;
  readonly visible?: unknown;
  readonly empty?: unknown;
} {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as {
            readonly attached?: unknown;
            readonly visible?: unknown;
            readonly empty?: unknown;
          })
        : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && value !== null
    ? (value as {
        readonly attached?: unknown;
        readonly visible?: unknown;
        readonly empty?: unknown;
      })
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
      description.empty === false &&
      // A backgrounded WebView is still the current app page. `attached` is
      // the lifecycle signal that distinguishes it from a stale descriptor.
      description.attached === true &&
      target.title === 'Trinity'
    );
  });
  if (candidates.length > 1) {
    throw new Error(
      `Expected one attached Trinity WebView target; found ${candidates.length}`,
    );
  }
  return candidates[0];
}

function websocketEndpoint(
  target: DevtoolsTarget | undefined,
): string | undefined {
  if (typeof target?.webSocketDebuggerUrl !== 'string') return undefined;
  try {
    const endpoint = new URL(target.webSocketDebuggerUrl);
    return endpoint.protocol === 'ws:' || endpoint.protocol === 'wss:'
      ? target.webSocketDebuggerUrl
      : undefined;
  } catch {
    return undefined;
  }
}

function browserEndpoint(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return websocketEndpoint(
    value as { readonly webSocketDebuggerUrl?: unknown },
  );
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
  let browser: DevtoolsConnection | undefined;
  const pages = new Set<DevtoolsConnection>();
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
      for (const page of pages) {
        try {
          page.close(abortError(signal));
        } catch (error) {
          failures.push(error);
        }
      }
      pages.clear();
      try {
        browser?.close(abortError(signal));
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
      let version: unknown;
      try {
        version = await abortable(
          fetchJson(`http://127.0.0.1:${port}/json/version`, {
            signal: readinessSignal,
          }).then((response) => response.json()),
          readinessSignal,
          () => undefined,
        );
      } catch (error) {
        readinessSignal.throwIfAborted();
        lastReadError = error;
      }
      endpoint = browserEndpoint(version);
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
      `Android WebView did not publish a browser DevTools endpoint: ${String(lastReadError ?? 'no endpoint')}`,
    );
    browser = await abortable(
      connect(endpoint, { signal, timeoutMs: 5_000 }),
      readinessSignal,
      (lateConnection) => lateConnection.close(abortError(signal)),
    );
    // Boot/theme updates can recreate the Activity and WebView in the same
    // process. Keep the test TLS exception on that process's browser session.
    await abortable(
      browser.send('Security.setIgnoreCertificateErrors', {
        ignore: true,
      }),
      readinessSignal,
      () => undefined,
    );

    const operationTimeoutMs = 5_000;
    const readPageOnce = async (
      operationSignal: AbortSignal,
    ): Promise<DevtoolsTarget | undefined> => {
      const response = await abortable(
        fetchJson(`http://127.0.0.1:${port}/json`, {
          signal: operationSignal,
        }).then((result) => result.json()),
        operationSignal,
        () => undefined,
      );
      return selectTarget(response);
    };
    const readPage = async (
      operationSignal: AbortSignal,
    ): Promise<DevtoolsTarget> => {
      while (!operationSignal.aborted) {
        const target = await readPageOnce(operationSignal);
        if (target) return target;
        await delay(Math.min(options.pollIntervalMs ?? 100, 100), undefined, {
          signal: operationSignal,
        });
      }
      throw abortError(operationSignal);
    };
    const send = async (
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<unknown> => {
      const operationSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(operationTimeoutMs),
      ]);
      operationSignal.throwIfAborted();
      const target = await readPage(operationSignal);
      let page: DevtoolsConnection | undefined;
      try {
        const initialEndpoint = websocketEndpoint(target);
        assert(
          initialEndpoint,
          'Current Trinity WebView target has no endpoint',
        );
        try {
          page = await abortable(
            connect(initialEndpoint, {
              signal: operationSignal,
              timeoutMs: 5_000,
            }),
            operationSignal,
            (lateConnection) =>
              lateConnection.close(abortError(operationSignal)),
          );
        } catch (error) {
          // A recreation can replace the target after enumeration. Only retry
          // when a fresh observation proves that exact endpoint is gone.
          let replacement = await readPageOnce(operationSignal);
          let replacementEndpoint = websocketEndpoint(replacement);
          if (replacementEndpoint === initialEndpoint) throw error;
          while (!replacementEndpoint && !operationSignal.aborted) {
            await delay(
              Math.min(options.pollIntervalMs ?? 100, 100),
              undefined,
              {
                signal: operationSignal,
              },
            );
            replacement = await readPageOnce(operationSignal);
            replacementEndpoint = websocketEndpoint(replacement);
            if (replacementEndpoint === initialEndpoint) throw error;
          }
          if (!replacementEndpoint) throw error;
          page = await abortable(
            connect(replacementEndpoint, {
              signal: operationSignal,
              timeoutMs: 5_000,
            }),
            operationSignal,
            (lateConnection) =>
              lateConnection.close(abortError(operationSignal)),
          );
        }
        pages.add(page);
        // Calling send marks the command dispatched; never replay after this.
        return await page.send(method, params);
      } finally {
        if (page) {
          pages.delete(page);
          page.close(abortError(operationSignal));
        }
      }
    };
    const diagnostics: DevtoolsConnection = { send, close };
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
