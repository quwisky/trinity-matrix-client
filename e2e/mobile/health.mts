export const ANDROID_INFRASTRUCTURE_FAILURE = 'ANDROID_INFRASTRUCTURE_FAILURE';
export const ADB_FAILURE_LIMIT = 2;

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
    forceKillTimer = setTimeout(() => terminate('SIGKILL'), forceKillAfterMs);
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

export function nextAdbFailureCount(
  previousFailures: number,
  state: string | undefined,
): number {
  return state?.trim() === 'device' ? 0 : previousFailures + 1;
}
