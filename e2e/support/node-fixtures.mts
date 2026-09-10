import { inspect } from 'node:util';
import {
  createTestResourceNamespace,
  withTestResourceNamespace,
  type TestResourceNamespace,
} from './namespace.mts';
import { createProcessTerminationScope } from './managed-command.mts';
import { readSession } from './session.mts';
import { MatrixTestResources } from './test-resources.mts';

export interface NodeTestFixtureOptions {
  readonly suiteId?: string;
  readonly testId: string;
  readonly retry?: number;
  readonly workerIndex?: number;
  readonly sessionId?: string;
  readonly signal?: AbortSignal;
}

export interface NodeTestFixtures {
  readonly namespace: TestResourceNamespace;
  readonly matrixResources: MatrixTestResources;
  readonly signal: AbortSignal;
}

/** Run one serial node:test attempt with the same resource ownership contract as Playwright. */
export async function withNodeTestResources<T>(
  options: NodeTestFixtureOptions,
  operation: (fixtures: NodeTestFixtures) => Promise<T>,
): Promise<T> {
  const termination = createProcessTerminationScope();
  const signal = options.signal
    ? AbortSignal.any([options.signal, termination.signal])
    : termination.signal;
  const namespace = createTestResourceNamespace({
    sessionId: options.sessionId ?? readSession().id,
    suiteId:
      options.suiteId ?? process.env['TRINITY_E2E_SUITE_ID'] ?? 'node-test',
    workerIndex: options.workerIndex ?? 0,
    testId: options.testId,
    retry: options.retry ?? 0,
  });
  let assertionError: unknown;
  let result: T | undefined;
  try {
    signal.throwIfAborted();
    await withTestResourceNamespace(namespace, async () => {
      try {
        result = await operation({
          namespace,
          matrixResources: new MatrixTestResources(namespace),
          signal,
        });
      } catch (error) {
        assertionError = error;
      }
    });
    if (assertionError === undefined && signal.aborted) {
      assertionError =
        signal.reason instanceof Error
          ? signal.reason
          : new Error('E2E test interrupted', { cause: signal.reason });
    }
  } finally {
    let cleanupError: unknown;
    try {
      await namespace.cleanup();
    } catch (error) {
      cleanupError = error;
      // Node test IPC drops nested AggregateError entries. Preserve their
      // causes in the process diagnostics before the failure is serialized.
      console.error(inspect(error, { depth: null, colors: false }));
    }
    termination.close();
    if (assertionError !== undefined && cleanupError !== undefined) {
      throw new AggregateError(
        [assertionError, cleanupError],
        `Node test ${namespace.id} failed and cleanup failed`,
      );
    }
    if (assertionError !== undefined) throw assertionError;
    if (cleanupError !== undefined) throw cleanupError;
  }
  return result as T;
}
