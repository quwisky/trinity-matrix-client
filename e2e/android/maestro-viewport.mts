import assert from 'node:assert/strict';
import {
  openDevtoolsConnection,
  type DevtoolsConnection,
} from '../support/devtools-connection.mts';
import type { MaestroDevice } from './maestro-session.mts';

export interface MaestroViewport {
  apply(size?: ViewportSize): Promise<void>;
  installDocumentScript(source: string): Promise<() => Promise<void>>;
  nativePoint(point: { readonly x: number; readonly y: number }): Promise<{
    readonly x: number;
    readonly y: number;
  }>;
  close(): Promise<void>;
}

export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

export interface MaestroViewportOptions {
  readonly pid: string;
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor?: number;
  readonly userAgent?: string;
  readonly isMobile?: boolean;
  readonly hasTouch?: boolean;
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

interface TargetGeometry {
  readonly screenX: number;
  readonly screenY: number;
  readonly width: number;
  readonly height: number;
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

function targetGeometry(target: DevtoolsTarget): TargetGeometry | undefined {
  const description = parseDescription(target.description);
  const values = ['screenX', 'screenY', 'width', 'height'].map(
    (key) => description[key],
  );
  if (
    values.some(
      (value) =>
        typeof value !== 'number' || !Number.isFinite(value),
    )
  )
    return undefined;
  const [screenX, screenY, width, height] = values as number[];
  if (width <= 0 || height <= 0) return undefined;
  return { screenX, screenY, width, height };
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

function validSize(size: ViewportSize): ViewportSize {
  assert(
    Number.isSafeInteger(size.width) && size.width > 0 &&
      Number.isSafeInteger(size.height) && size.height > 0,
    'Viewport dimensions must be positive integers',
  );
  return { width: size.width, height: size.height };
}

function evaluationValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const result = value as { result?: unknown; value?: unknown };
  let nested: unknown = result.result ?? value;
  if (nested && typeof nested === 'object' && 'result' in nested)
    nested = (nested as { result?: unknown }).result;
  if (nested && typeof nested === 'object' && 'value' in nested)
    nested = (nested as { value?: unknown }).value;
  return nested;
}

function metricValue(value: unknown): {
  readonly width?: unknown;
  readonly height?: unknown;
  readonly dpr?: unknown;
} | undefined {
  const nested = evaluationValue(value);
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
  const initialSize = validSize(options);
  const deviceScaleFactor = options.deviceScaleFactor ?? 1;
  assert(
    Number.isFinite(deviceScaleFactor) && deviceScaleFactor > 0,
    'Device scale factor must be positive and finite',
  );
  const isMobile = options.isMobile ?? true;
  const hasTouch = options.hasTouch ?? true;

  let port: string | undefined;
  let page: DevtoolsConnection | undefined;
  let connecting = false;
  let applied = false;
  let requestedSize = initialSize;
  let physicalCssWidth: number | undefined;
  let physicalTargetWidth: number | undefined;
  let viewportScale = 1;
  let originalUserAgent: string | undefined;
  let userAgentApplied = false;
  let forwarding: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const documentScripts = new Set<string>();
  const removeForward = async (): Promise<void> => {
    const allocated = port;
    port = undefined;
    if (allocated) await device.removeForward(`tcp:${allocated}`);
  };
  const cleanup = async (): Promise<void> => {
    const failures: unknown[] = [];
    for (const identifier of documentScripts) {
      documentScripts.delete(identifier);
      try {
        await page?.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await page?.send('Emulation.clearDeviceMetricsOverride');
    } catch (error) {
      failures.push(error);
    }
    if (userAgentApplied && originalUserAgent !== undefined) {
      try {
        await page?.send('Network.setUserAgentOverride', {
          userAgent: originalUserAgent,
        });
      } catch (error) {
        failures.push(error);
      }
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
    const currentTarget = async (): Promise<DevtoolsTarget> => {
      const observed = selectTarget(await readTargets());
      if (endpoint(observed) !== endpoint(target))
        throw new Error('Trinity WebView target was replaced during viewport use');
      return observed;
    };
    if (options.userAgent !== undefined) {
      const userAgent = evaluationValue(
        await page.send('Runtime.evaluate', {
          expression: 'navigator.userAgent',
          returnByValue: true,
        }),
      );
      assert(typeof userAgent === 'string', 'Current WebView user agent is unavailable');
      originalUserAgent = userAgent;
      // The command can mutate Chromium before its reply rejects. Mark restoration
      // required before dispatch so partial CDP failures cannot strand the override.
      userAgentApplied = true;
      await page.send('Network.setUserAgentOverride', {
        userAgent: options.userAgent,
      });
    }
    const apply = async (size?: ViewportSize): Promise<void> => {
      signal.throwIfAborted();
      const nextSize = size === undefined ? requestedSize : validSize(size);
      const observed = await currentTarget();
      const observedGeometry = targetGeometry(observed);
      requestedSize = nextSize;
      const metrics = await page?.send('Runtime.evaluate', {
        expression:
          '({width: innerWidth, height: innerHeight, dpr: devicePixelRatio})',
        returnByValue: true,
      });
      const value = metricValue(metrics);
      if (
        applied &&
        (observedGeometry?.width === undefined ||
          observedGeometry.width === physicalTargetWidth) &&
        value?.width === requestedSize.width &&
        value.height === requestedSize.height &&
        typeof value.dpr === 'number' &&
        Math.abs(value.dpr - deviceScaleFactor) < 1e-6
      )
        return;
      applied = false;
      await page?.send('Emulation.clearDeviceMetricsOverride');
      const physical = await page?.send('Page.getLayoutMetrics');
      const physicalWidth =
        physical && typeof physical === 'object'
          ? (physical as {
              cssVisualViewport?: { clientWidth?: unknown };
            }).cssVisualViewport?.clientWidth
          : undefined;
      assert(typeof physicalWidth === 'number' && Number.isFinite(physicalWidth) && physicalWidth > 0, 'Physical WebView layout width is unavailable');
      const scale = Math.min(1, physicalWidth / requestedSize.width);
      await page?.send('Emulation.setDeviceMetricsOverride', {
        width: requestedSize.width,
        height: requestedSize.height,
        deviceScaleFactor,
        mobile: isMobile,
        screenWidth: requestedSize.width,
        screenHeight: requestedSize.height,
        scale,
      });
      await page?.send('Emulation.setTouchEmulationEnabled', {
        enabled: hasTouch,
        maxTouchPoints: hasTouch ? 5 : 1,
      });
      physicalCssWidth = physicalWidth;
      physicalTargetWidth = observedGeometry?.width;
      viewportScale = scale;
      applied = true;
    };
    const nativePoint = async (point: {
      readonly x: number;
      readonly y: number;
    }): Promise<{ readonly x: number; readonly y: number }> => {
      signal.throwIfAborted();
      assert(
        Number.isFinite(point.x) && Number.isFinite(point.y) &&
          point.x >= 0 && point.x <= requestedSize.width &&
          point.y >= 0 && point.y <= requestedSize.height,
        'Native point is outside the requested viewport',
      );
      const observed = await currentTarget();
      const geometry = targetGeometry(observed);
      assert(geometry, 'Current Trinity target has no native bounds');
      assert(
        physicalCssWidth !== undefined && physicalTargetWidth !== undefined,
        'Native point mapping is unavailable before viewport apply',
      );
      assert(
        geometry.width === physicalTargetWidth,
        'Native WebView width changed; reapply the viewport before mapping points',
      );
      const factor =
        (physicalTargetWidth / physicalCssWidth) * viewportScale;
      const mapped = {
        x: Math.round(geometry.screenX + point.x * factor),
        y: Math.round(geometry.screenY + point.y * factor),
      };
      assert(
        mapped.x >= geometry.screenX &&
          mapped.x <= geometry.screenX + geometry.width &&
          mapped.y >= geometry.screenY &&
          mapped.y <= geometry.screenY + geometry.height,
        'Native point is outside the attached WebView bounds',
      );
      return mapped;
    };
    // Chromium owns these registrations per CDP session. Keep them on the same
    // retained connection as the viewport; per-command diagnostics cannot own them.
    const installDocumentScript = async (source: string): Promise<() => Promise<void>> => {
      signal.throwIfAborted();
      await currentTarget();
      // Registration alone stores the source; Page.enable activates Chromium's
      // new-document callbacks on this retained session.
      await page!.send('Page.enable');
      const result = await page!.send('Page.addScriptToEvaluateOnNewDocument', { source });
      signal.throwIfAborted();
      assert(result && typeof result === 'object' && 'identifier' in result && typeof result.identifier === 'string', 'Document script registration has no identifier');
      const identifier = result.identifier;
      documentScripts.add(identifier);
      return async () => {
        if (!documentScripts.delete(identifier)) return;
        await page!.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
      };
    };
    signal.throwIfAborted();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    return { apply, nativePoint, installDocumentScript, close };
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
