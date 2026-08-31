import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  createProcessTerminationScope,
  runManagedCommand,
} from './managed-command.mts';

describe('managed E2E commands', () => {
  it('turns process termination into a disposable abort scope', () => {
    const events = new EventEmitter();
    const scope = createProcessTerminationScope(events);
    events.emit('SIGINT');
    expect(scope.signal.aborted).toBe(true);
    expect(scope.signal.reason).toBeInstanceOf(Error);
    scope.close();
    expect(events.listenerCount('SIGINT')).toBe(0);
    expect(events.listenerCount('SIGTERM')).toBe(0);
  });

  it('does not spawn an already-cancelled command', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancel before spawn'));
    await expect(
      runManagedCommand(process.execPath, ['-e', 'process.exit(0)'], {
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({
      status: 1,
      timedOut: false,
      error: expect.objectContaining({ message: 'cancel before spawn' }),
    });
  });

  it('cancels a running process group without reporting a timeout', async () => {
    const controller = new AbortController();
    const result = runManagedCommand(
      process.execPath,
      ['-e', 'setInterval(() => undefined, 1000)'],
      {
        signal: controller.signal,
        terminationGraceMs: 1_000,
        stdio: 'ignore',
      },
    );
    setTimeout(() => controller.abort(new Error('test cancellation')), 50);
    await expect(result).resolves.toMatchObject({
      status: 1,
      timedOut: false,
    });
  });
});
