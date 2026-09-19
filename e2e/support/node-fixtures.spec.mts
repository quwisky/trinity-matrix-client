import { describe, expect, it } from 'vitest';
import { withNodeTestResources } from './node-fixtures.mts';
import { currentTestResourceNamespace } from './namespace.mts';

describe('Node test fixtures', () => {
  it('binds the namespace and combines assertion and cleanup failures', async () => {
    let failure: unknown;
    try {
      await withNodeTestResources(
        { sessionId: 'session-node', suiteId: 'node.suite', testId: 'case' },
        async ({ namespace, matrixResources }) => {
          expect(currentTestResourceNamespace()).toBe(namespace);
          expect(matrixResources.namespace).toBe(namespace);
          namespace.registerCleanup('cleanup', async () => {
            throw new Error('cleanup failed');
          });
          throw new Error('assertion failed');
        },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: 'assertion failed' }),
        expect.objectContaining({
          message: expect.stringContaining('cleanup failed'),
        }),
      ]),
    );
  });

  it('exposes the merged caller signal and turns cancellation after work into failure', async () => {
    const controller = new AbortController();
    let cleaned = false;
    let observedSignal: AbortSignal | undefined;
    await expect(
      withNodeTestResources(
        {
          sessionId: 'session-node',
          suiteId: 'node.suite',
          testId: 'cancelled',
          signal: controller.signal,
        },
        async ({ namespace, signal }) => {
          observedSignal = signal;
          namespace.registerCleanup('cleanup', async () => {
            cleaned = true;
          });
          controller.abort(new Error('caller cancelled'));
          return 'resolved after cancellation';
        },
      ),
    ).rejects.toThrow('caller cancelled');
    expect(observedSignal).toBeDefined();
    if (observedSignal === undefined) {
      throw new Error('withNodeTestResources did not expose a signal');
    }
    expect(observedSignal.aborted).toBe(true);
    expect(cleaned).toBe(true);
  });

  it('combines cancellation and cleanup failures after namespace cleanup', async () => {
    const controller = new AbortController();
    let cleaned = false;
    let failure: unknown;
    try {
      await withNodeTestResources(
        {
          sessionId: 'session-node',
          suiteId: 'node.suite',
          testId: 'cancelled-cleanup',
          signal: controller.signal,
        },
        async ({ namespace }) => {
          namespace.registerCleanup('cleanup', async () => {
            cleaned = true;
            throw new Error('cleanup failed');
          });
          controller.abort(new Error('caller cancelled'));
        },
      );
    } catch (error) {
      failure = error;
    }
    expect(cleaned).toBe(true);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: 'caller cancelled' }),
        expect.objectContaining({
          message: expect.stringContaining('cleanup failed'),
        }),
      ]),
    );
  });
});
