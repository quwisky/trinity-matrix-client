import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const completionFile = (directory: string) =>
  join(directory, 'completion.json');

describe('runPlaywright scheduled completion boundary', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it.each([
    { name: 'passes', result: { status: 0 } },
    { name: 'fails normally', result: { status: 2 } },
  ])(
    'writes the record after cleanup for a command that $name',
    async ({ result }) => {
      const directory = mkdtempSync(join(tmpdir(), 'trinity-e2e-completion-'));
      const file = completionFile(directory);
      let releaseCleanup!: () => void;
      const cleanupFinished = new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      });
      const close = vi.fn(async () => cleanupFinished);
      const runManagedCommand = vi.fn(async () => result);
      const openE2EInvocation = vi.fn(async ({ environment }) => ({
        environment,
        close,
      }));
      vi.doMock('./invocation.mts', () => ({ openE2EInvocation }));
      vi.doMock('./managed-command.mts', () => ({
        createProcessTerminationScope: () => ({
          signal: new AbortController().signal,
          close: vi.fn(),
        }),
        runManagedCommand,
      }));

      try {
        const { runPlaywright } = await import('./run-playwright.mts');
        const execution = runPlaywright(
          ['--config=e2e/support/playwright-config.mts'],
          {
            TRINITY_E2E_SAFE_COMPLETION_FILE: file,
            TRINITY_E2E_SAFE_COMPLETION_SUITE: 'components.storybook',
          },
        );

        await vi.waitFor(() =>
          expect(runManagedCommand).toHaveBeenCalledOnce(),
        );
        expect(existsSync(file)).toBe(false);
        releaseCleanup();
        await expect(execution).resolves.toBe(result.status);
        expect(close).toHaveBeenCalledOnce();
        expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
          schemaVersion: 1,
          suiteId: 'components.storybook',
          status: result.status,
        });
      } finally {
        releaseCleanup();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([
    {
      name: 'a process error',
      result: { status: 1, error: new Error('spawn failed') },
    },
    { name: 'a signal', result: { status: 1, signal: 'SIGTERM' } },
    { name: 'a timeout', result: { status: 1, timedOut: true } },
  ])('does not write a record after $name', async ({ result }) => {
    const directory = mkdtempSync(join(tmpdir(), 'trinity-e2e-completion-'));
    const file = completionFile(directory);
    const close = vi.fn(async () => undefined);
    const runManagedCommand = vi.fn(async () => result);
    const openE2EInvocation = vi.fn(async ({ environment }) => ({
      environment,
      close,
    }));
    vi.doMock('./invocation.mts', () => ({ openE2EInvocation }));
    vi.doMock('./managed-command.mts', () => ({
      createProcessTerminationScope: () => ({
        signal: new AbortController().signal,
        close: vi.fn(),
      }),
      runManagedCommand,
    }));

    try {
      const { runPlaywright } = await import('./run-playwright.mts');
      await expect(
        runPlaywright(['--config=e2e/support/playwright-config.mts'], {
          TRINITY_E2E_SAFE_COMPLETION_FILE: file,
          TRINITY_E2E_SAFE_COMPLETION_SUITE: 'components.storybook',
        }),
      ).resolves.toBe(result.status);
      expect(existsSync(file)).toBe(false);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not write a record when invocation cleanup rejects', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'trinity-e2e-completion-'));
    const file = completionFile(directory);
    const runManagedCommand = vi.fn(async () => ({ status: 0 }));
    const openE2EInvocation = vi.fn(async ({ environment }) => ({
      environment,
      close: vi.fn(async () => {
        throw new Error('cleanup failed');
      }),
    }));
    vi.doMock('./invocation.mts', () => ({ openE2EInvocation }));
    vi.doMock('./managed-command.mts', () => ({
      createProcessTerminationScope: () => ({
        signal: new AbortController().signal,
        close: vi.fn(),
      }),
      runManagedCommand,
    }));

    try {
      const { runPlaywright } = await import('./run-playwright.mts');
      await expect(
        runPlaywright(['--config=e2e/support/playwright-config.mts'], {
          TRINITY_E2E_SAFE_COMPLETION_FILE: file,
          TRINITY_E2E_SAFE_COMPLETION_SUITE: 'components.storybook',
        }),
      ).rejects.toThrow('cleanup failed');
      expect(existsSync(file)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not certify a normal command result after owner cancellation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'trinity-e2e-completion-'));
    const file = completionFile(directory);
    const controller = new AbortController();
    const runManagedCommand = vi.fn(async () => ({ status: 0 }));
    const openE2EInvocation = vi.fn(async ({ environment }) => ({
      environment,
      close: vi.fn(async () => undefined),
    }));
    vi.doMock('./invocation.mts', () => ({ openE2EInvocation }));
    vi.doMock('./managed-command.mts', () => ({
      createProcessTerminationScope: () => ({
        signal: controller.signal,
        close: vi.fn(),
      }),
      runManagedCommand,
    }));

    try {
      controller.abort(new Error('owner cancelled'));
      const { runPlaywright } = await import('./run-playwright.mts');
      await expect(
        runPlaywright(['--config=e2e/support/playwright-config.mts'], {
          TRINITY_E2E_SAFE_COMPLETION_FILE: file,
          TRINITY_E2E_SAFE_COMPLETION_SUITE: 'components.storybook',
        }),
      ).resolves.toBe(0);
      expect(existsSync(file)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
