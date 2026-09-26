import { describe, expect, it } from 'vitest';
import { openMaestroTargetPoint } from '../e2e/android/maestro-target-point.mts';

const within = (promise, timeoutMs = 1_000) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('test timeout')), timeoutMs),
    ),
  ]);

describe('Maestro current target point endpoint', () => {
  it('reads the point only after the flow starts and returns the updated point', async () => {
    const controller = new AbortController();
    let flowStarted = false;
    let reads = 0;
    const endpoint = await openMaestroTargetPoint({
      signal: controller.signal,
      readPoint: async () => {
        expect(flowStarted).toBe(true);
        reads += 1;
        return { x: 30 + reads, y: 362 + reads };
      },
    });
    try {
      flowStarted = true;
      const response = await fetch(endpoint.url);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('31,363');
      expect(endpoint.lastPoint).toEqual({ x: 31, y: 363 });
    } finally {
      await endpoint.close();
    }
  });

  it('rejects invalid routes and read failures without a successful point response', async () => {
    const controller = new AbortController();
    const endpoint = await openMaestroTargetPoint({
      signal: controller.signal,
      readPoint: async () => {
        throw new Error('point read failed');
      },
    });
    try {
      const invalid = await fetch(`${endpoint.url}/extra`);
      expect(invalid.status).toBe(404);
      const failed = await fetch(endpoint.url);
      expect(failed.status).toBe(500);
      expect(await failed.text()).toBe('POINT_UNAVAILABLE');
      expect(endpoint.lastPoint).toBeUndefined();
      expect(endpoint.lastError).toBeInstanceOf(Error);
      expect(endpoint.lastError.message).toBe('point read failed');
    } finally {
      await endpoint.close();
    }
  });

  it('reports the latest read, so a later success supersedes an earlier miss', async () => {
    const controller = new AbortController();
    let reads = 0;
    const endpoint = await openMaestroTargetPoint({
      signal: controller.signal,
      readPoint: async () => {
        reads += 1;
        if (reads === 1) throw new Error('target not rendered yet');
        return { x: 12, y: 34 };
      },
    });
    try {
      expect((await fetch(endpoint.url)).status).toBe(500);
      expect(endpoint.lastError?.message).toBe('target not rendered yet');
      const ready = await fetch(endpoint.url);
      expect(ready.status).toBe(200);
      expect(await ready.text()).toBe('12,34');
      expect(endpoint.lastError).toBeUndefined();
      expect(endpoint.lastPoint).toEqual({ x: 12, y: 34 });
    } finally {
      await endpoint.close();
    }
  });

  it('times out an ignored read and surfaces the bounded failure', async () => {
    const controller = new AbortController();
    const endpoint = await openMaestroTargetPoint({
      signal: controller.signal,
      readTimeoutMs: 20,
      readPoint: async () => await new Promise(() => undefined),
    });
    try {
      const response = await fetch(endpoint.url);
      expect(response.status).toBe(500);
      expect(endpoint.lastError).toBeInstanceOf(Error);
      expect(endpoint.lastError.message).toBe('Target point read timed out');
    } finally {
      const closeError = await endpoint.close().catch((error) => error);
      expect(closeError).toBeInstanceOf(AggregateError);
      expect(
        closeError.errors.some((error) =>
          String(error).includes('pending read did not terminate'),
        ),
      ).toBe(true);
    }
  });

  it('aborts a started pending read and releases the loopback server within its bound', async () => {
    const controller = new AbortController();
    let started;
    const startedReading = new Promise((resolve) => {
      started = resolve;
    });
    const endpoint = await openMaestroTargetPoint({
      signal: controller.signal,
      readPoint: async (signal) =>
        await new Promise((_, reject) => {
          started();
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    });
    const pending = fetch(endpoint.url);
    await startedReading;
    controller.abort(new Error('test abort'));
    await within(endpoint.close());
    await expect(pending).rejects.toThrow();
  });

  it('awaits cleanup when cancelled while the loopback listener is starting', async () => {
    const controller = new AbortController();
    const opening = openMaestroTargetPoint({
      signal: controller.signal,
      readPoint: async () => ({ x: 1, y: 2 }),
    });
    controller.abort(new Error('listen abort'));
    await expect(opening).rejects.toThrow('listen abort');
  });
});
