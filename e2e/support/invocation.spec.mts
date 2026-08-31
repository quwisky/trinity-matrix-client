import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  openE2EInvocation,
  type InvocationDependencies,
} from './invocation.mts';
import {
  acquireProcessLock,
  releaseProcessLock,
  type ProcessLock,
} from './process-lock.mts';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function listeningServer(): Promise<Server> {
  const server = createServer((_request, response) => response.end('ok'));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return server;
}

function dependencies(
  overrides: Partial<InvocationDependencies> = {},
): InvocationDependencies {
  return {
    serveDirectory: vi.fn(() => listeningServer()),
    startSynapse: vi.fn(async () => ({
      available: true,
      hs: 'https://localhost:8448',
      user: 'test-user',
      pass: 'secret-value',
    })),
    stopSynapse: vi.fn(async () => undefined),
    acquireSynapse: vi.fn(async () => ({ file: 'synapse', owner: 'owner' })),
    releaseSynapse: vi.fn(),
    acquireLock: vi.fn((file): ProcessLock => ({
      file,
      owner: `owner-${file}`,
    })),
    releaseLock: vi.fn(),
    ...overrides,
  };
}

function temporaryWorkspace(): string {
  const directory = mkdtempSync(join(tmpdir(), 'trinity-e2e-invocation-'));
  directories.push(directory);
  return directory;
}

describe('E2E invocation ownership', () => {
  it('binds dynamic endpoints and lets children join without restarting resources', async () => {
    const workspaceRoot = temporaryWorkspace();
    const adapters = dependencies();
    const owner = await openE2EInvocation(
      { resources: ['synapse'], workspaceRoot, environment: {} },
      adapters,
    );
    const ports = Object.values(owner.descriptor.endpoints).map(
      (origin) => new URL(origin).port,
    );
    expect(new Set(ports).size).toBe(3);
    expect(ports.every((port) => Number(port) > 0)).toBe(true);

    const child = await openE2EInvocation(
      {
        resources: ['synapse'],
        workspaceRoot,
        environment: owner.environment,
      },
      adapters,
    );
    expect(child.owned).toBe(false);
    expect(child.descriptor.id).toBe(owner.descriptor.id);
    expect(adapters.startSynapse).toHaveBeenCalledTimes(1);
    await child.close();
    expect(adapters.stopSynapse).not.toHaveBeenCalled();

    await owner.close();
    expect(adapters.stopSynapse).toHaveBeenCalledTimes(1);
  });

  it('rejects a child that asks its parent for an unowned resource', async () => {
    const workspaceRoot = temporaryWorkspace();
    const owner = await openE2EInvocation(
      { resources: [], workspaceRoot, environment: {} },
      dependencies(),
    );
    await expect(
      openE2EInvocation({
        resources: ['synapse'],
        workspaceRoot,
        environment: owner.environment,
      }),
    ).rejects.toThrow(/not owned/);
    await owner.close();
  });

  it('does no setup after cancellation and surfaces bounded teardown failures', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const cancelledAdapters = dependencies();
    await expect(
      openE2EInvocation(
        {
          workspaceRoot: temporaryWorkspace(),
          environment: {},
          signal: controller.signal,
        },
        cancelledAdapters,
      ),
    ).rejects.toThrow('cancelled');
    expect(cancelledAdapters.serveDirectory).not.toHaveBeenCalled();

    const failingAdapters = dependencies({
      stopSynapse: vi.fn(async () => {
        throw new Error('compose down failed');
      }),
    });
    const owner = await openE2EInvocation(
      {
        resources: ['synapse'],
        workspaceRoot: temporaryWorkspace(),
        environment: {},
        teardownTimeoutMs: 500,
      },
      failingAdapters,
    );
    await expect(owner.close()).rejects.toThrow(/teardown failed/);
  });

  it('stops Synapse when startup fails after Compose may have created containers', async () => {
    const adapters = dependencies({
      startSynapse: vi.fn(async () => {
        throw new Error('readiness failed');
      }),
    });
    await expect(
      openE2EInvocation(
        {
          resources: ['synapse'],
          workspaceRoot: temporaryWorkspace(),
          environment: {},
        },
        adapters,
      ),
    ).rejects.toThrow('readiness failed');
    expect(adapters.stopSynapse).toHaveBeenCalledTimes(1);
    expect(adapters.releaseSynapse).toHaveBeenCalledTimes(1);
  });

  it('rejects a competing live Synapse owner', async () => {
    const workspaceRoot = temporaryWorkspace();
    const leaseFile = join(workspaceRoot, 'synapse.lock');
    const adapters = dependencies({
      acquireSynapse: async () =>
        acquireProcessLock(leaseFile, 'test Synapse owner'),
      releaseSynapse: releaseProcessLock,
    });
    const owner = await openE2EInvocation(
      { resources: ['synapse'], workspaceRoot, environment: {} },
      adapters,
    );

    await expect(
      openE2EInvocation(
        { resources: ['synapse'], workspaceRoot, environment: {} },
        adapters,
      ),
    ).rejects.toThrow(/already running/);
    await owner.close();
  });

  it('cancels and settles timed-out Synapse teardown before releasing its lease', async () => {
    const events: string[] = [];
    const adapters = dependencies({
      stopSynapse: vi.fn(
        ({ signal }) =>
          new Promise<void>((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () => {
                events.push('aborted');
                setTimeout(() => {
                  events.push('settled');
                  reject(signal.reason);
                }, 5);
              },
              { once: true },
            );
          }),
      ),
      releaseSynapse: vi.fn(() => events.push('released')),
    });
    const owner = await openE2EInvocation(
      {
        resources: ['synapse'],
        workspaceRoot: temporaryWorkspace(),
        environment: {},
        teardownTimeoutMs: 10,
      },
      adapters,
    );

    await expect(owner.close()).rejects.toThrow(/teardown failed/);
    expect(events).toEqual(['aborted', 'settled', 'released']);
  });

  it('restores owner-process URL and TLS policy after Synapse startup', async () => {
    const previousBaseUrl = process.env['BASE_URL'];
    const previousTlsPolicy = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    process.env['BASE_URL'] = 'http://127.0.0.1:49999';
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '1';
    const adapters = dependencies({
      startSynapse: vi.fn(async () => {
        expect(process.env['BASE_URL']).toMatch(/^http:\/\/127\.0\.0\.1:/);
        expect(process.env['NODE_TLS_REJECT_UNAUTHORIZED']).toBe('0');
        return {
          available: true,
          hs: 'https://localhost:8448',
          user: 'test-user',
          pass: 'secret-value',
        };
      }),
    });
    try {
      const owner = await openE2EInvocation(
        {
          resources: ['synapse'],
          workspaceRoot: temporaryWorkspace(),
          environment: {},
        },
        adapters,
      );
      expect(process.env['BASE_URL']).toBe('http://127.0.0.1:49999');
      expect(process.env['NODE_TLS_REJECT_UNAUTHORIZED']).toBe('1');
      await owner.close();
    } finally {
      if (previousBaseUrl === undefined) delete process.env['BASE_URL'];
      else process.env['BASE_URL'] = previousBaseUrl;
      if (previousTlsPolicy === undefined)
        delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
      else process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = previousTlsPolicy;
    }
  });

  it('closes every server that bound before a sibling startup failed', async () => {
    const bound = await listeningServer();
    const reportServer = await listeningServer();
    const adapters = dependencies({
      serveDirectory: vi
        .fn<InvocationDependencies['serveDirectory']>()
        .mockResolvedValueOnce(bound)
        .mockRejectedValueOnce(new Error('storybook bind failed'))
        .mockResolvedValueOnce(reportServer),
    });

    await expect(
      openE2EInvocation(
        { workspaceRoot: temporaryWorkspace(), environment: {} },
        adapters,
      ),
    ).rejects.toThrow(/static servers failed to start/);
    expect(bound.listening).toBe(false);
    expect(reportServer.listening).toBe(false);
  });
});
