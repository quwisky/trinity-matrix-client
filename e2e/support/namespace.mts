import { createHash } from 'node:crypto';

// Playwright runs one test at a time inside each worker process. Keep the active
// namespace in that worker: fixture continuations do not inherit an
// AsyncLocalStorage context created around `use()`, while a module-local value is
// isolated by the worker process and remains active for the whole test callback.
let activeNamespace: TestResourceNamespace | undefined;

export interface TestNamespaceSeed {
  readonly sessionId: string;
  readonly suiteId: string;
  readonly workerIndex: number;
  readonly testId: string;
  readonly retry: number;
}

export interface TestResourceNamespace {
  readonly id: string;
  role(name: string): string;
  next(name: string): string;
  registerCleanup(label: string, cleanup: () => Promise<void>): void;
  cleanup(): Promise<void>;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 28);
}

/** Unique, deterministic names for one Playwright test attempt and all its clients. */
export function createTestResourceNamespace(
  seed: TestNamespaceSeed,
): TestResourceNamespace {
  const digest = createHash('sha256')
    .update(JSON.stringify(seed))
    .digest('hex')
    .slice(0, 10);
  const id = `${slug(seed.suiteId)}-w${seed.workerIndex}-r${seed.retry}-${digest}`;
  const cleanups: Array<{ label: string; cleanup: () => Promise<void> }> = [];
  const counters = new Map<string, number>();
  let cleaned = false;
  return {
    id,
    role: (name) => `${id}-${slug(name) || 'client'}`,
    next(name) {
      const normalized = slug(name) || 'resource';
      const next = (counters.get(normalized) ?? 0) + 1;
      counters.set(normalized, next);
      return `${id}-${normalized}-${next}`;
    },
    registerCleanup(label, cleanup) {
      if (cleaned)
        throw new Error(`Cannot register ${label} after namespace cleanup`);
      cleanups.push({ label, cleanup });
    },
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      const failures: Error[] = [];
      for (const item of cleanups.reverse()) {
        try {
          await item.cleanup();
        } catch (error) {
          failures.push(
            new Error(`E2E cleanup failed for ${item.label}`, { cause: error }),
          );
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `E2E namespace ${id} cleanup failed`,
        );
      }
    },
  };
}

export async function withTestResourceNamespace<T>(
  namespace: TestResourceNamespace,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = activeNamespace;
  activeNamespace = namespace;
  try {
    return await operation();
  } finally {
    activeNamespace = previous;
  }
}

export function currentTestResourceNamespace(): TestResourceNamespace {
  const namespace = activeNamespace;
  if (!namespace) throw new Error('No active E2E test-resource namespace');
  return namespace;
}

/** Stable ID for one named resource inside the current Playwright test attempt. */
export function testResourceId(role: string): string {
  return currentTestResourceNamespace().role(role);
}

/** Unique ID for repeated resources of the same role inside one test attempt. */
export function nextTestResourceId(role: string): string {
  return currentTestResourceNamespace().next(role);
}
