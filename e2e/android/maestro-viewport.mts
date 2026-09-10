import assert from 'node:assert/strict';
import {
  openDevtoolsConnection,
  type DevtoolsConnection,
} from '../support/devtools-connection.mts';
import type { MaestroDevice } from './maestro-session.mts';

export interface MaestroViewport {
  apply(): Promise<void>;
  close(): Promise<void>;
}

export interface MaestroViewportOptions {
  readonly pid: string;
  readonly width: number;
  readonly height: number;
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

function parseDescription(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function targetsFrom(value: unknown): DevtoolsTarget[] {
  return Array.isArray(value)
    ? value.filter(
        (target): target is DevtoolsTarget =>
          target !== null && typeof target === 'object',
      )
    : [];
}

function endpoint(target: DevtoolsTarget): string | undefined {
  if (typeof target.webSocketDebuggerUrl !== 'string') return undefined;
  try {
    const url = new URL(target.webSocketDebuggerUrl);
    return url.protocol === 'ws:' || url.protocol === 'wss:'
      ? target.webSocketDebuggerUrl
      : undefined;
  } catch {
    return undefined;
  }
}

function selectTarget(value: unknown): DevtoolsTarget {
  const candidates = targetsFrom(value).filter((target) => {
    const description = parseDescription(target.description);
    return (
      target.type === 'page' &&
      target.title === 'Trinity' &&
      typeof target.url === 'string' &&
      target.url.startsWith('https://localhost/') &&
      description.attached === true &&
      description.empty === false
    );
  });
  if (candidates.length !== 1) {
    throw new Error(
      `Expected one attached Trinity WebView target; found ${candidates.length}`,
    );
  }
  const selected = candidates[0];
  assert(selected, 'Trinity WebView target selection unexpectedly empty');
  assert(endpoint(selected), 'Current Trinity WebView target has no endpoint');
  return selected;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Android viewport attachment cancelled');
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

function metricValue(value: unknown): {
  readonly width?: unknown;
  readonly height?: unknown;
  readonly dpr?: unknown;
} | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const result = value as { result?: unknown; value?: unknown };
  let nested: unknown = result.result ?? value;
  if (nested && typeof nested === 'object' && 'result' in nested)
    nested = (nested as { result?: unknown }).result;
  if (nested && typeof nested === 'object' && 'value' in nested)
    nested = (nested as { value?: unknown }).value;
  if (!nested || typeof nested !== 'object') return undefined;
  return nested as {
    readonly width?: unknown;
    readonly height?: unknown;
    readonly dpr?: unknown;
  };
}

export async function openMaestroViewport(
  device: MaestroDevice,
  options: MaestroViewportOptions,
): Promise<MaestroViewport> {
  const controller = new AbortController();
  const connectionController = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const connectionSignal = options.signal
    ? AbortSignal.any([options.signal, connectionController.signal])
    : connectionController.signal;
  signal.throwIfAborted();
  assert(/^\d+$/.test(options.pid), 'Android WebView pid must be numeric');
  assert(Number.isSafeInteger(options.width) && options.width > 0 && Number.isSafeInteger(options.height) && options.height > 0, 'Viewport dimensions must be positive integers');

  let port: string | undefined;
  let page: DevtoolsConnection | undefined;
  let connecting = false;
  let applied = false;
  let forwarding: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const removeForward = async (): Promise<void> => {
    const allocated = port;
    port = undefined;
    if (allocated) await device.removeForward(`tcp:${allocated}`);
  };
  const cleanup = async (): Promise<void> => {
    const failures: unknown[] = [];
    try {
      await page?.send('Emulation.clearDeviceMetricsOverride');
    } catch (error) {
      failures.push(error);
    }
    try {
      await page?.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    } catch (error) {
      failures.push(error);
    }
    try {
      page?.close(abortError(signal));
    } catch (error) {
      failures.push(error);
    }
    try {
      if (forwarding)
        await abortable(forwarding, AbortSignal.timeout(2_000), () => undefined);
    } catch (error) {
      failures.push(error);
    }
    try {
      await removeForward();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length)
      throw new AggregateError(failures, 'Android viewport cleanup failed');
  };
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      controller.abort(new Error('Android viewport closed'));
      if (connecting) {
        connectionController.abort();
      }
      try {
        await cleanup();
      } finally {
        options.signal?.removeEventListener('abort', onAbort);
        controller.abort(new Error('Android viewport closed during attach'));
        connectionController.abort(new Error('Android viewport closed'));
      }
    })());
  const onAbort = (): void => {
    void close().catch(() => undefined);
  };

  try {
    forwarding = device
      .adb(
        'forward',
        'tcp:0',
        `localabstract:webview_devtools_remote_${options.pid}`,
      )
      .then(async (value) => {
        port = value.trim();
        assert(/^\d+$/.test(port), 'ADB must allocate a viewport forward port');
        if (signal.aborted) await removeForward();
      });
    await abortable(forwarding, signal, () => undefined);
    const fetchJson =
      options.fetch ??
      ((input: string, init?: { readonly signal?: AbortSignal }) =>
        fetch(input, { signal: init?.signal }));
    const readTargets = async (): Promise<unknown> =>
      abortable(
        fetchJson(`http://127.0.0.1:${port}/json`, { signal }),
        signal,
        () => undefined,
      ).then((response) =>
        abortable(response.json(), signal, () => undefined),
      );
    const target = selectTarget(await readTargets());
    const connect = options.connect ?? openDevtoolsConnection;
    connecting = true;
    try {
      page = await abortable(
        connect(endpoint(target) as string, {
          signal: connectionSignal,
          timeoutMs: 5_000,
        }),
        signal,
        (latePage) => latePage.close(abortError(signal)),
      );
    } finally {
      connecting = false;
    }
    const currentTarget = async (): Promise<void> => {
      const observed = selectTarget(await readTargets());
      if (endpoint(observed) !== endpoint(target))
        throw new Error('Trinity WebView target was replaced during viewport use');
    };
    const apply = async (): Promise<void> => {
      signal.throwIfAborted();
      await currentTarget();
      const metrics = await page?.send('Runtime.evaluate', {
        expression:
          '({width: innerWidth, height: innerHeight, dpr: devicePixelRatio})',
        returnByValue: true,
      });
      const value = metricValue(metrics);
      if (
        applied &&
        value?.width === options.width &&
        value.height === options.height &&
        typeof value.dpr === 'number' &&
        Math.abs(value.dpr - 1) < 1e-6
      )
        return;
      await page?.send('Emulation.clearDeviceMetricsOverride');
      const physical = await page?.send('Page.getLayoutMetrics');
      const physicalWidth =
        physical && typeof physical === 'object'
          ? (physical as {
              cssVisualViewport?: { clientWidth?: unknown };
            }).cssVisualViewport?.clientWidth
          : undefined;
      assert(typeof physicalWidth === 'number' && Number.isFinite(physicalWidth) && physicalWidth > 0, 'Physical WebView layout width is unavailable');
      const scale = Math.min(1, physicalWidth / options.width);
      await page?.send('Emulation.setDeviceMetricsOverride', {
        width: options.width,
        height: options.height,
        deviceScaleFactor: 1,
        mobile: true,
        screenWidth: options.width,
        screenHeight: options.height,
        scale,
      });
      await page?.send('Emulation.setTouchEmulationEnabled', {
        enabled: true,
        maxTouchPoints: 5,
      });
      applied = true;
    };
    signal.throwIfAborted();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    return { apply, close };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Android viewport attachment and cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw error;
  }
}
