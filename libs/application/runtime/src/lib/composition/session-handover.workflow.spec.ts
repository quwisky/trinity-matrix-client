import { ErrorHandler, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TrnSurfaceService } from '@trinity/components/overlay';
import {
  SESSION_ENGINE,
  type PendingTextMessage,
  type SessionEngine,
} from '@trinity/data-access/matrix-client';
import {
  AccountRuntimeService,
  type AccountLifecycleState,
} from '@trinity/data-access/accounts';
import {
  AppRestartService,
  SESSION_HANDOVER_TIMEOUT_MS,
  SessionLockService,
} from '@trinity/platform-native';
import { MockProvider } from 'ng-mocks';
import { Subject, defer, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SESSION_HANDOVER_DRAIN_MS,
  SessionHandoverWorkflow,
} from './session-handover.workflow';
import { UnsentDraftsWriter } from './unsent-drafts.writer';

const HANDED_OVER = [
  'pause-sync',
  'read-unsent',
  'stop',
  'close-dialogs',
  'write-drafts',
  'reload',
] as const;

const UNSENT: PendingTextMessage = {
  accountId: '@me:hs',
  roomId: '!room:hs',
  threadRootId: null,
  text: 'see you',
};

function setup(
  options: {
    readonly outgoing?: () => boolean;
    readonly pauseFails?: boolean;
    readonly readFails?: boolean;
    readonly stopFails?: boolean;
    readonly closeFails?: boolean;
    readonly unsent?: () => readonly PendingTextMessage[];
    readonly lifecycleBusy?: boolean;
    readonly reloadFails?: boolean;
    readonly restartFails?: boolean;
  } = {},
) {
  const steps: string[] = [];
  const lifecycleBusy = signal(options.lifecycleBusy ?? false);
  const lifecycle = signal<AccountLifecycleState>({ phase: 'idle' });
  const requests = new Subject<void>();
  const failing = (message: string) => throwError(() => new Error(message));
  const matrix = {
    pauseSync: vi.fn(() =>
      defer(() => {
        steps.push('pause-sync');
        return options.pauseFails
          ? failing('the sync loop would not stop')
          : of(null);
      }),
    ),
    hasOutgoingWork: vi.fn(() =>
      defer(() => {
        try {
          return of((options.outgoing ?? (() => false))());
        } catch (error: unknown) {
          return throwError(() => error);
        }
      }),
    ),
    pendingTextMessages: vi.fn(() =>
      defer(() => {
        steps.push('read-unsent');
        return options.readFails
          ? failing('a room could not be read')
          : of(options.unsent?.() ?? []);
      }),
    ),
    stop: vi.fn(() =>
      defer(() => {
        steps.push('stop');
        return options.stopFails ? failing('stop failed') : of(null);
      }),
    ),
    remove: vi.fn(),
    signOutAll: vi.fn(),
  } satisfies Partial<Record<keyof SessionEngine, unknown>>;
  const closeAll = vi.fn(() => {
    steps.push('close-dialogs');
    if (options.closeFails) throw new Error('a dialog would not close');
  });
  const reload = vi.fn(() => {
    steps.push('reload');
    if (options.reloadFails) throw new Error('the reload was refused');
  });
  const restart = vi.fn(() => {
    steps.push('restart-at-root');
    if (options.restartFails) throw new Error('the navigation was refused');
  });
  const handleError = vi.fn();
  const writeBack = vi.fn((_messages: readonly PendingTextMessage[]) => {
    steps.push('write-drafts');
    return Promise.resolve();
  });
  TestBed.configureTestingModule({
    providers: [
      SessionHandoverWorkflow,
      MockProvider(SessionLockService, {
        handoverRequests: requests.asObservable(),
      }),
      { provide: SESSION_ENGINE, useValue: matrix },
      MockProvider(TrnSurfaceService, { closeAll }),
      MockProvider(AppRestartService, { reload, restart }),
      MockProvider(UnsentDraftsWriter, { writeBack }),
      { provide: ErrorHandler, useValue: { handleError } },
      MockProvider(AccountRuntimeService, {
        lifecycleBusy: lifecycleBusy.asReadonly(),
        lifecycle: lifecycle.asReadonly(),
      }),
    ],
  });
  const lifetime = TestBed.inject(SessionHandoverWorkflow).run().subscribe();
  return {
    steps,
    requests,
    matrix,
    reload,
    restart,
    writeBack,
    lifetime,
    lifecycleBusy,
    lifecycle,
    handleError,
  };
}

describe('SessionHandoverWorkflow', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it('stops syncing at once, then stops the clients, closes dialogs and reloads in place, wiping nothing', async () => {
    const { steps, requests, matrix, restart, lifetime } = setup();

    requests.next();

    expect(steps).toEqual(['pause-sync']);
    await vi.advanceTimersByTimeAsync(100);
    expect(steps).toEqual(HANDED_OVER);
    expect(matrix.remove).not.toHaveBeenCalled();
    expect(matrix.signOutAll).not.toHaveBeenCalled();
    // A reload keeps the route; a restart at `/` would lose the room this tab showed.
    expect(restart).not.toHaveBeenCalled();
    lifetime.unsubscribe();
  });

  it('waits for messages and uploads already on their way before stopping the clients', async () => {
    const outgoing = vi
      .fn<() => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const { steps, requests, lifetime } = setup({ outgoing });

    requests.next();
    await vi.advanceTimersByTimeAsync(650);
    expect(steps).toEqual(['pause-sync']);
    await vi.advanceTimersByTimeAsync(200);

    expect(steps).toEqual(HANDED_OVER);
    lifetime.unsubscribe();
  });

  it('polls outgoing work between pausing and reading the unsent text', async () => {
    const { steps, requests, matrix, lifetime } = setup();
    matrix.hasOutgoingWork.mockImplementation(() =>
      defer(() => {
        steps.push('has-outgoing-work');
        return of(false);
      }),
    );

    requests.next();
    await vi.advanceTimersByTimeAsync(100);

    expect(steps.slice(0, 4)).toEqual([
      'pause-sync',
      'has-outgoing-work',
      'read-unsent',
      'stop',
    ]);
    lifetime.unsubscribe();
  });

  it('stops the clients after five seconds even if a send never settles', async () => {
    const { steps, requests, matrix, lifetime } = setup({
      outgoing: () => true,
    });

    requests.next();
    await vi.advanceTimersByTimeAsync(SESSION_HANDOVER_DRAIN_MS - 100);
    expect(steps).toEqual(['pause-sync']);
    await vi.advanceTimersByTimeAsync(200);

    expect(steps).toEqual(HANDED_OVER);
    // It polls at a fixed interval rather than busy-waiting: once at the start, then every 250 ms.
    expect(matrix.hasOutgoingWork.mock.calls.length).toBeLessThanOrEqual(21);
    lifetime.unsubscribe();
  });

  it('still reloads when stopping the clients fails', async () => {
    const { steps, requests, lifetime } = setup({ stopFails: true });

    requests.next();
    await vi.advanceTimersByTimeAsync(100);

    expect(steps).toEqual(HANDED_OVER);
    lifetime.unsubscribe();
  });

  it('still writes the drafts and reloads when a dialog will not close', async () => {
    const { steps, requests, writeBack, lifetime } = setup({
      closeFails: true,
      unsent: () => [UNSENT],
    });

    requests.next();
    await vi.advanceTimersByTimeAsync(100);

    expect(steps).toEqual(HANDED_OVER);
    expect(writeBack).toHaveBeenCalledExactlyOnceWith([UNSENT]);
    lifetime.unsubscribe();
  });

  it('puts the text still unsent after the drain back in its draft, read before the clients stop', async () => {
    const { steps, requests, writeBack, lifetime } = setup({
      unsent: () => [UNSENT],
    });

    requests.next();
    await vi.advanceTimersByTimeAsync(100);

    expect(writeBack).toHaveBeenCalledExactlyOnceWith([UNSENT]);
    expect(steps.indexOf('read-unsent')).toBeLessThan(steps.indexOf('stop'));
    expect(steps.indexOf('write-drafts')).toBeLessThan(steps.indexOf('reload'));
    lifetime.unsubscribe();
  });

  it('does not write back a message that reached the server during the drain', async () => {
    let onItsWay: readonly PendingTextMessage[] = [UNSENT];
    const outgoing = vi
      .fn<() => boolean>()
      .mockImplementationOnce(() => true)
      .mockImplementation(() => {
        // The server accepted it inside the grace: no longer pending.
        onItsWay = [];
        return false;
      });
    const { requests, writeBack, lifetime } = setup({
      outgoing,
      unsent: () => onItsWay,
    });

    requests.next();
    await vi.advanceTimersByTimeAsync(600);

    expect(writeBack).toHaveBeenCalledExactlyOnceWith([]);
    lifetime.unsubscribe();
  });

  it('still reloads when the drafts cannot be written', async () => {
    const { steps, requests, writeBack, lifetime } = setup({
      unsent: () => [UNSENT],
    });
    writeBack.mockImplementationOnce(() => {
      steps.push('write-drafts');
      return Promise.reject(new Error('quota'));
    });

    requests.next();
    await vi.advanceTimersByTimeAsync(100);

    expect(steps).toEqual(HANDED_OVER);
    lifetime.unsubscribe();
  });

  it('still reloads when writing the drafts throws before it returns a promise', async () => {
    const { steps, requests, writeBack, lifetime } = setup({
      unsent: () => [UNSENT],
    });
    writeBack.mockImplementationOnce(() => {
      steps.push('write-drafts');
      throw new Error('a draft key could not be built');
    });

    requests.next();
    await vi.advanceTimersByTimeAsync(100);

    expect(steps).toEqual(HANDED_OVER);
    lifetime.unsubscribe();
  });

  it('still reads the unsent text, stops the clients and reloads when sync will not pause', async () => {
    const { steps, requests, writeBack, lifetime } = setup({
      pauseFails: true,
      unsent: () => [UNSENT],
    });

    requests.next();
    await vi.advanceTimersByTimeAsync(100);

    expect(steps).toEqual(HANDED_OVER);
    expect(writeBack).toHaveBeenCalledExactlyOnceWith([UNSENT]);
    lifetime.unsubscribe();
  });

  it('still stops the clients and reloads when the unsent text cannot be read', async () => {
    const { steps, requests, writeBack, lifetime } = setup({
      readFails: true,
    });

    requests.next();
    await vi.advanceTimersByTimeAsync(100);

    expect(steps).toEqual(HANDED_OVER);
    expect(writeBack).toHaveBeenCalledExactlyOnceWith([]);
    lifetime.unsubscribe();
  });

  it('ends the drain and hands over when the outgoing work cannot be read', async () => {
    const { steps, requests, writeBack, lifetime } = setup({
      outgoing: () => {
        throw new Error('a room could not be read');
      },
      unsent: () => [UNSENT],
    });

    requests.next();
    await vi.advanceTimersByTimeAsync(100);

    expect(steps).toEqual(HANDED_OVER);
    expect(writeBack).toHaveBeenCalledExactlyOnceWith([UNSENT]);
    lifetime.unsubscribe();
  });

  it('hands over once when another request arrives during the drain', async () => {
    const { requests, matrix, reload, lifetime } = setup({
      outgoing: () => true,
    });

    requests.next();
    await vi.advanceTimersByTimeAsync(1_000);
    requests.next();
    await vi.advanceTimersByTimeAsync(SESSION_HANDOVER_DRAIN_MS + 1_000);

    expect(matrix.pauseSync).toHaveBeenCalledOnce();
    expect(matrix.stop).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
    lifetime.unsubscribe();
  });

  it('restarts the app at its root when the reload in place fails, so the lock is still freed', async () => {
    const { steps, requests, handleError, lifetime } = setup({
      reloadFails: true,
    });

    requests.next();
    await vi.advanceTimersByTimeAsync(100);

    expect(steps).toEqual([...HANDED_OVER, 'restart-at-root']);
    expect(handleError).not.toHaveBeenCalled();
    lifetime.unsubscribe();
  });

  it('reports through the error handler when neither the reload nor the restart works', async () => {
    const { steps, requests, handleError, lifetime } = setup({
      reloadFails: true,
      restartFails: true,
    });

    requests.next();
    await vi.advanceTimersByTimeAsync(100);

    expect(steps).toEqual([...HANDED_OVER, 'restart-at-root']);
    expect(handleError).toHaveBeenCalledOnce();
    // The handover still ends: the lifetime keeps answering requests.
    expect(lifetime.closed).toBe(false);
    lifetime.unsubscribe();
  });

  describe('while an erase or a sign-out is under way in this tab', () => {
    it('waits for it to settle, then hands over', async () => {
      const { steps, requests, lifecycleBusy, lifecycle, lifetime } = setup({
        lifecycleBusy: true,
      });

      requests.next();
      await vi.advanceTimersByTimeAsync(2_000);
      // Nothing paused, stopped or written while the destructive work runs.
      expect(steps).toEqual([]);

      lifecycle.set({
        phase: 'settled',
        attempt: 1,
        operation: 'signing-out-account',
        outcome: {
          kind: 'ready',
          accountId: '@me:hs',
          activeAccountId: null,
          remainingAccountIds: [],
        },
      });
      lifecycleBusy.set(false);
      await vi.advanceTimersByTimeAsync(500);

      expect(steps).toEqual(HANDED_OVER);
      lifetime.unsubscribe();
    });

    it('does not hand over at all when the erase it waited for restarts the app', async () => {
      const { steps, requests, reload, lifecycleBusy, lifecycle, lifetime } =
        setup({ lifecycleBusy: true });

      requests.next();
      await vi.advanceTimersByTimeAsync(1_000);
      lifecycle.set({
        phase: 'settled',
        attempt: 1,
        operation: 'resetting-installation',
        outcome: { kind: 'ready' },
      });
      lifecycleBusy.set(false);
      await vi.advanceTimersByTimeAsync(SESSION_HANDOVER_DRAIN_MS + 1_000);

      expect(steps).toEqual([]);
      expect(reload).not.toHaveBeenCalled();
      lifetime.unsubscribe();
    });

    it('hands over after an erase that left residue, which keeps the app running', async () => {
      const { steps, requests, lifecycleBusy, lifecycle, lifetime } = setup({
        lifecycleBusy: true,
      });

      requests.next();
      await vi.advanceTimersByTimeAsync(1_000);
      lifecycle.set({
        phase: 'settled',
        attempt: 1,
        operation: 'resetting-installation',
        outcome: {
          kind: 'partial-cleanup',
          issues: [{ scope: 'indexed-db', recovery: 'restart-application' }],
        },
      });
      lifecycleBusy.set(false);
      await vi.advanceTimersByTimeAsync(500);

      expect(steps).toEqual(HANDED_OVER);
      lifetime.unsubscribe();
    });

    it('gives up when it is still running after the handover timeout, and answers the next request', async () => {
      const { steps, requests, lifecycleBusy, lifetime } = setup({
        lifecycleBusy: true,
      });

      requests.next();
      await vi.advanceTimersByTimeAsync(SESSION_HANDOVER_TIMEOUT_MS - 100);
      expect(steps).toEqual([]);
      await vi.advanceTimersByTimeAsync(200);
      // The requester has shown "Try again" by now; this tab never hands over half-wiped.
      lifecycleBusy.set(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(steps).toEqual([]);

      requests.next();
      expect(steps).toEqual(['pause-sync']);
      await vi.advanceTimersByTimeAsync(100);
      expect(steps).toEqual(HANDED_OVER);
      lifetime.unsubscribe();
    });
  });
});
