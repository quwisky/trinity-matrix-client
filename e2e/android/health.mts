export const ANDROID_INFRASTRUCTURE_FAILURE =
  'ANDROID_INFRASTRUCTURE_FAILURE';
export const ADB_FAILURE_LIMIT = 2;
export const ANDROID_SURFACE_INITIAL_TIMEOUT_MS = 10_000;
export const ANDROID_SURFACE_RECOVERY_TIMEOUT_MS = 30_000;
export const ANDROID_WEBVIEW_LIVENESS_TIMEOUT_MS = 2_000;

export type AndroidInfrastructureLayer =
  | 'application-surface'
  | 'application-webview'
  | 'emulator-process'
  | 'playwright-driver'
  | 'transport';

const androidInfrastructureLayers = [
  'application-surface',
  'application-webview',
  'emulator-process',
  'playwright-driver',
  'transport',
] as const satisfies readonly AndroidInfrastructureLayer[];

function isAndroidInfrastructureLayer(
  value: unknown,
): value is AndroidInfrastructureLayer {
  return androidInfrastructureLayers.some((layer) => layer === value);
}

export interface AndroidInfrastructureFailure {
  readonly kind: typeof ANDROID_INFRASTRUCTURE_FAILURE;
  readonly version: 1;
  readonly layer: AndroidInfrastructureLayer;
  readonly serial: string;
  readonly summary: string;
  readonly recordedAt: string;
}

export type AndroidApplicationSurfaceState =
  | 'ready'
  | 'route-empty'
  | 'runtime-blocked'
  | 'runtime-restoring'
  | 'static-boot';

export interface StabilizedApplicationSurface {
  readonly state: AndroidApplicationSurfaceState;
  readonly recovered: boolean;
}

export async function runAndroidInfrastructureOperation<T>(
  operation: () => Promise<T>,
  isInfrastructureFailure: (error: unknown) => boolean | Promise<boolean>,
  failure: () => Error,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (await isInfrastructureFailure(error)) throw failure();
    throw error;
  }
}

export function isPlaywrightTargetLoss(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return [
    /\btarget page, context or browser (?:has been |was )?closed\b/i,
    /\b(?:browser|page) (?:has been |was )?closed\b/i,
    /\bconnection (?:has been |was )?closed\b/i,
  ].some((pattern) => pattern.test(error.message));
}

export async function isAndroidWebViewProbeUnavailable(
  probe: () => Promise<unknown>,
  timeoutMs = ANDROID_WEBVIEW_LIVENESS_TIMEOUT_MS,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(probe).then(
        () => false,
        (error: unknown) => isPlaywrightTargetLoss(error),
      ),
      new Promise<true>((resolve) => {
        timeout = setTimeout(() => resolve(true), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export interface AndroidInfrastructureWatchdog {
  readonly failure: Error | undefined;
  stop(): void;
}

interface AndroidInfrastructureWatchdogOptions {
  readonly inspect: () => Promise<Error | undefined>;
  readonly terminate: (signal: 'SIGTERM' | 'SIGKILL') => void;
  readonly intervalMs?: number;
  readonly forceKillAfterMs?: number;
}

/**
 * Monitors the outer Android lifecycle without overlapping probes. The first
 * classified failure terminates once, arms one bounded force-kill fallback,
 * and prevents every later probe from producing a second suite failure.
 */
export function startAndroidInfrastructureWatchdog({
  inspect,
  terminate,
  intervalMs = 2_000,
  forceKillAfterMs = 10_000,
}: AndroidInfrastructureWatchdogOptions): AndroidInfrastructureWatchdog {
  let failure: Error | undefined;
  let inspectionRunning = false;
  let stopped = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

  const recordFailure = (inspectedFailure: Error): void => {
    if (stopped || failure) return;
    failure = inspectedFailure;
    terminate('SIGTERM');
    forceKillTimer = setTimeout(
      () => terminate('SIGKILL'),
      forceKillAfterMs,
    );
    forceKillTimer.unref();
  };

  const inspectOnce = async (): Promise<void> => {
    if (stopped || inspectionRunning || failure) return;
    inspectionRunning = true;
    try {
      const inspectedFailure = await inspect();
      if (inspectedFailure) recordFailure(inspectedFailure);
    } catch (error) {
      recordFailure(
        error instanceof Error
          ? error
          : new Error('Android infrastructure inspection failed'),
      );
    } finally {
      inspectionRunning = false;
    }
  };

  const inspectionTimer = setInterval(() => void inspectOnce(), intervalMs);
  inspectionTimer.unref();

  return {
    get failure() {
      return failure;
    },
    stop(): void {
      stopped = true;
      clearInterval(inspectionTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
    },
  };
}

/**
 * Gives an installed WebView one document-level recovery for transient boot
 * states. A visibly blocked startup is a product result, not a host retry
 * signal, and a second stalled observation is deliberately returned to the
 * caller for infrastructure classification.
 */
export async function stabilizeApplicationSurface(
  inspect: () => Promise<AndroidApplicationSurfaceState>,
  recover?: () => Promise<void>,
): Promise<StabilizedApplicationSurface> {
  let state = await inspect();
  if (
    state === 'ready' ||
    state === 'runtime-blocked' ||
    !recover
  ) {
    return { state, recovered: false };
  }

  await recover();
  state = await inspect();
  return { state, recovered: true };
}

export function parseInfrastructureFailure(
  source: string,
): AndroidInfrastructureFailure {
  const value: unknown = JSON.parse(source);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('kind' in value) ||
    value.kind !== ANDROID_INFRASTRUCTURE_FAILURE ||
    !('version' in value) ||
    value.version !== 1 ||
    !('layer' in value) ||
    !isAndroidInfrastructureLayer(value.layer) ||
    !('serial' in value) ||
    typeof value.serial !== 'string' ||
    !('summary' in value) ||
    typeof value.summary !== 'string' ||
    !('recordedAt' in value) ||
    typeof value.recordedAt !== 'string'
  ) {
    throw new Error('Invalid Android infrastructure failure marker');
  }
  return {
    kind: value.kind,
    version: value.version,
    layer: value.layer,
    serial: value.serial,
    summary: value.summary,
    recordedAt: value.recordedAt,
  };
}

export function nextAdbFailureCount(
  previousFailures: number,
  state: string | undefined,
): number {
  return state?.trim() === 'device' ? 0 : previousFailures + 1;
}

/** Process names reported by Android's Java and native crash-buffer formats. */
export function crashProcessNames(crashLog: string): string[] {
  const names = new Set<string>();
  const patterns = [
    /\bProcess:\s*([a-zA-Z0-9_.:-]+)/g,
    /\bCmdline:\s*([a-zA-Z0-9_.:-]+)/g,
    />>>\s*([a-zA-Z0-9_.:-]+)\s*<<</g,
  ];
  for (const pattern of patterns) {
    for (const match of crashLog.matchAll(pattern)) names.add(match[1]!);
  }
  return [...names];
}

export function trinityCrashProcessNames(crashLog: string): string[] {
  const packages = ['eu.qwky.trinity', 'eu.qwky.trinity.secondary'];
  return crashProcessNames(crashLog).filter((processName) =>
    packages.some(
      (pkg) => processName === pkg || processName.startsWith(`${pkg}:`),
    ),
  );
}
