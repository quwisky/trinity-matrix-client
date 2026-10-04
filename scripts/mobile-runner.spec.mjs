import { describe, expect, it, vi } from 'vitest';

describe('mobile runner lifecycle module', () => {
  it('imports without an Android SDK and registers nothing until a run starts', async () => {
    vi.stubEnv('ANDROID_HOME', '');
    vi.stubEnv('ANDROID_SDK_ROOT', '');
    const listeners = process.listenerCount('SIGINT');
    const runner = await import('../e2e/mobile/support/runner.mts');
    expect(typeof runner.startMobileRun).toBe('function');
    expect(runner.commandSignal()?.aborted).toBe(false);
    expect(process.listenerCount('SIGINT')).toBe(listeners);
    vi.unstubAllEnvs();
  });
});
