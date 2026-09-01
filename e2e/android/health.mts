export const ANDROID_INFRASTRUCTURE_FAILURE =
  'ANDROID_INFRASTRUCTURE_FAILURE';
export const ADB_FAILURE_LIMIT = 2;

export type AndroidInfrastructureLayer =
  | 'application-surface'
  | 'application-webview'
  | 'emulator-process'
  | 'playwright-driver'
  | 'transport';

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
  const value = JSON.parse(source) as Partial<AndroidInfrastructureFailure>;
  if (
    value.kind !== ANDROID_INFRASTRUCTURE_FAILURE ||
    value.version !== 1 ||
    typeof value.layer !== 'string' ||
    typeof value.serial !== 'string' ||
    typeof value.summary !== 'string' ||
    typeof value.recordedAt !== 'string'
  ) {
    throw new Error('Invalid Android infrastructure failure marker');
  }
  return value as AndroidInfrastructureFailure;
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
