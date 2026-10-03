import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { join, resolve } from 'node:path';
import {
  acquireProcessLock,
  releaseProcessLock,
  type ProcessLock,
} from './process-lock.mts';
import {
  E2E_SESSION_ENV,
  E2E_SESSION_VERSION,
  readSession,
  removeSession,
  sessionEnvironment,
  sessionFileFor,
  sessionSummary,
  writeSession,
  type E2ESessionDescriptor,
  type HomeserverSessionDescriptor,
} from './session.mts';
// The HTTP server and Docker harness remain executable Node adapters; this module owns them.
// @ts-expect-error The executable static-server adapter is intentionally plain ESM.
import { serve, serverOrigin } from './serve.mjs';
import { start as startHomeserver } from './homeserver/start.mjs';
import { stop as stopHomeserver } from './homeserver/stop.mjs';
import {
  acquireHomeserverLease,
  releaseHomeserverLease,
} from './homeserver/lease.mts';

export interface E2EInvocation {
  readonly owned: boolean;
  readonly descriptor: E2ESessionDescriptor;
  readonly file: string;
  readonly environment: NodeJS.ProcessEnv;
  close(): Promise<void>;
}

export interface OpenInvocationOptions {
  readonly resources?: readonly string[];
  readonly workspaceRoot?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly teardownTimeoutMs?: number;
}

export interface InvocationDependencies {
  readonly serveDirectory: (root: string) => Promise<Server>;
  readonly startHomeserver: (options: {
    signal?: AbortSignal;
  }) => Promise<HomeserverSessionDescriptor>;
  readonly stopHomeserver: (options: { signal?: AbortSignal }) => Promise<void>;
  readonly acquireHomeserver: (signal?: AbortSignal) => Promise<ProcessLock>;
  readonly releaseHomeserver: (lock: ProcessLock | undefined) => void;
  readonly acquireLock: (file: string, description: string) => ProcessLock;
  readonly releaseLock: (lock: ProcessLock | undefined) => void;
}

const defaultDependencies: InvocationDependencies = {
  serveDirectory: (root) => serve(root, 0) as Promise<Server>,
  startHomeserver: async (options) => ({
    available: true,
    ...(await startHomeserver(options)),
  }),
  stopHomeserver,
  acquireHomeserver: acquireHomeserverLease,
  releaseHomeserver: releaseHomeserverLease,
  acquireLock: acquireProcessLock,
  releaseLock: releaseProcessLock,
};

function closeServer(server: Server, timeoutMs: number): Promise<void> {
  return new Promise((resolveClose, reject) => {
    const timer = setTimeout(() => {
      server.closeAllConnections?.();
      reject(
        new Error(`Static E2E server did not close within ${timeoutMs} ms`),
      );
    }, timeoutMs);
    server.close((error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolveClose();
    });
  });
}

function assertResources(
  descriptor: E2ESessionDescriptor,
  requested: readonly string[],
): void {
  const missing = requested.filter(
    (resource) => !descriptor.resources.includes(resource),
  );
  if (missing.length > 0) {
    throw new Error(
      `E2E child requested resources not owned by session ${descriptor.id}: ${missing.join(', ')}`,
    );
  }
}

/**
 * Join the invocation named by the environment, or become its sole lifecycle owner.
 * A joiner validates the live parent and can never fall back to restarting resources.
 */
export async function openE2EInvocation(
  options: OpenInvocationOptions = {},
  dependencies: InvocationDependencies = defaultDependencies,
): Promise<E2EInvocation> {
  const environment = options.environment ?? process.env;
  const resources = [...new Set(options.resources ?? [])].sort();
  const inheritedFile = environment[E2E_SESSION_ENV];
  if (inheritedFile) {
    const descriptor = readSession(inheritedFile, { requireLiveOwner: true });
    assertResources(descriptor, resources);
    return {
      owned: false,
      descriptor,
      file: inheritedFile,
      environment: {
        ...environment,
        ...sessionEnvironment(descriptor, inheritedFile),
      },
      close: async () => undefined,
    };
  }

  options.signal?.throwIfAborted();
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const id = `${Date.now().toString(36)}-${randomUUID()}`;
  const file = sessionFileFor(workspaceRoot, id);
  const artifactsRoot = join(workspaceRoot, 'dist/.playwright', id);
  const locks: ProcessLock[] = [];
  const servers: Server[] = [];
  let homeserverLease: ProcessLock | undefined;
  let homeserverStopRequired = false;
  let published = false;
  let closed = false;
  const teardownTimeoutMs = options.teardownTimeoutMs ?? 15_000;

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    const failures: Error[] = [];
    if (homeserverStopRequired) {
      const controller = new AbortController();
      const timeoutError = new Error(
        `Synapse teardown timed out after ${teardownTimeoutMs} ms`,
      );
      let timer: NodeJS.Timeout | undefined;
      const teardown = dependencies.stopHomeserver({
        signal: controller.signal,
      });
      try {
        const outcome = await Promise.race([
          teardown.then(
            () => ({ kind: 'stopped' }) as const,
            (error: unknown) => ({ kind: 'failed', error }) as const,
          ),
          new Promise<{ readonly kind: 'timeout' }>((resolveTimeout) => {
            timer = setTimeout(
              () => resolveTimeout({ kind: 'timeout' }),
              teardownTimeoutMs,
            );
          }),
        ]);
        if (outcome.kind === 'failed') throw outcome.error;
        if (outcome.kind === 'timeout') {
          controller.abort(timeoutError);
          // Never release the fixed-port lease while Compose may still be
          // tearing down. The adapter contract requires cancellation to settle.
          await teardown.catch(() => undefined);
          throw timeoutError;
        }
      } catch (error) {
        failures.push(new Error('Synapse teardown failed', { cause: error }));
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    for (const server of servers.reverse()) {
      try {
        await closeServer(server, teardownTimeoutMs);
      } catch (error) {
        failures.push(
          new Error('Static-server teardown failed', { cause: error }),
        );
      }
    }
    if (published) removeSession(file);
    dependencies.releaseHomeserver(homeserverLease);
    for (const lock of locks.reverse()) dependencies.releaseLock(lock);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `E2E invocation ${id} teardown failed`,
      );
    }
  };

  try {
    for (const resource of resources.filter(
      (value) => value !== 'homeserver',
    )) {
      locks.push(
        dependencies.acquireLock(
          join(workspaceRoot, 'dist/.playwright/locks', `${resource}.lock`),
          `E2E resource ${resource}`,
        ),
      );
    }
    if (resources.includes('homeserver')) {
      homeserverLease = await dependencies.acquireHomeserver(options.signal);
    }
    options.signal?.throwIfAborted();

    const serverResults = await Promise.allSettled([
      dependencies.serveDirectory(join(workspaceRoot, 'www')),
      dependencies.serveDirectory(
        join(workspaceRoot, 'dist/storybook/components-storybook-host'),
      ),
      dependencies.serveDirectory(join(workspaceRoot, 'dist/.playwright')),
    ]);
    for (const result of serverResults) {
      if (result.status === 'fulfilled') servers.push(result.value);
    }
    const serverFailures = serverResults
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason as unknown);
    if (serverFailures.length > 0) {
      throw new AggregateError(
        serverFailures,
        'One or more E2E static servers failed to start',
      );
    }
    const [applicationServer, storybookServer, reportServer] =
      serverResults.map(
        (result) => (result as PromiseFulfilledResult<Server>).value,
      );
    const endpoints = {
      application: serverOrigin(applicationServer),
      storybook: serverOrigin(storybookServer),
      report: serverOrigin(reportServer),
    };

    let homeserver: HomeserverSessionDescriptor | undefined;
    if (resources.includes('homeserver')) {
      // From this point teardown is required even if readiness or registration fails:
      // Compose may already have created containers before startHomeserver rejects.
      homeserverStopRequired = true;
      const previousBaseUrl = process.env['BASE_URL'];
      const previousTlsPolicy = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
      process.env['BASE_URL'] = endpoints.application;
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
      try {
        homeserver = await dependencies.startHomeserver({
          signal: options.signal,
        });
      } finally {
        if (previousBaseUrl === undefined) delete process.env['BASE_URL'];
        else process.env['BASE_URL'] = previousBaseUrl;
        if (previousTlsPolicy === undefined)
          delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
        else process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = previousTlsPolicy;
      }
    }

    const descriptor: E2ESessionDescriptor = {
      version: E2E_SESSION_VERSION,
      id,
      workspaceRoot,
      owner: {
        pid: process.pid,
        nonce: randomUUID(),
        createdAt: new Date().toISOString(),
      },
      resources,
      endpoints,
      artifactsRoot,
      ...(homeserver ? { homeserver } : {}),
    };
    writeSession(file, descriptor);
    published = true;
    console.info(`[e2e] invocation owner ready: ${sessionSummary(descriptor)}`);
    return {
      owned: true,
      descriptor,
      file,
      environment: { ...environment, ...sessionEnvironment(descriptor, file) },
      close,
    };
  } catch (error) {
    await close().catch((teardownError: unknown) => {
      throw new AggregateError(
        [error, teardownError],
        `E2E invocation ${id} failed during setup and teardown`,
      );
    });
    throw error;
  }
}

export async function withE2EInvocation<T>(
  options: OpenInvocationOptions,
  operation: (invocation: E2EInvocation) => Promise<T>,
): Promise<T> {
  const invocation = await openE2EInvocation(options);
  try {
    return await operation(invocation);
  } finally {
    await invocation.close();
  }
}
