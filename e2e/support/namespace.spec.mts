import { describe, expect, it, vi } from 'vitest';
import {
  createTestResourceNamespace,
  currentTestResourceNamespace,
  withTestResourceNamespace,
} from './namespace.mts';
import { MatrixTestResources } from './test-resources.mts';

const seed = {
  sessionId: 'session',
  suiteId: 'browser.canonical',
  workerIndex: 2,
  testId: 'room creation creates and leaves a room',
  retry: 1,
};

describe('E2E test resources', () => {
  it('gives every attempt and multi-client role a stable isolated name', async () => {
    const first = createTestResourceNamespace(seed);
    const same = createTestResourceNamespace(seed);
    const nextWorker = createTestResourceNamespace({ ...seed, workerIndex: 3 });
    expect(first.id).toBe(same.id);
    expect(first.id).not.toBe(nextWorker.id);
    expect(first.role('primary')).not.toBe(first.role('secondary'));
    expect(first.next('event')).not.toBe(first.next('event'));

    const resources = new MatrixTestResources(first);
    expect(resources.userLocalpart('primary')).toMatch(/^[a-z0-9_]+$/);
    expect(resources.userLocalpart('primary')).not.toBe(
      resources.userLocalpart('secondary'),
    );
    expect(resources.roomName('conversation')).toContain(first.id);
    await expect(
      withTestResourceNamespace(first, async () =>
        currentTestResourceNamespace().role('third-client'),
      ),
    ).resolves.toContain(first.id);
  });

  it('runs all cleanup in reverse order and reports every failure', async () => {
    const namespace = createTestResourceNamespace(seed);
    const order: string[] = [];
    namespace.registerCleanup('first', async () => {
      order.push('first');
      throw new Error('first failure');
    });
    namespace.registerCleanup('second', async () => {
      order.push('second');
      throw new Error('second failure');
    });
    await expect(namespace.cleanup()).rejects.toThrow(/cleanup failed/);
    expect(order).toEqual(['second', 'first']);
    await namespace.cleanup();
    expect(vi.fn()).not.toHaveBeenCalled();
  });
});
