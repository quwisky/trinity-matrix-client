import { TestBed } from '@angular/core/testing';
import { TrnSurfaceService } from '@trinity/components/overlay';
import {
  MatrixClientService,
  type PendingTextMessage,
} from '@trinity/data-access/matrix-client';
import {
  AppRestartService,
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
    readonly stopFails?: boolean;
    readonly closeFails?: boolean;
    readonly unsent?: () => readonly PendingTextMessage[];
  } = {},
) {
  const steps: string[] = [];
  const requests = new Subject<void>();
  const matrix = {
    pauseSync: vi.fn(() => {
      steps.push('pause-sync');
    }),
    hasOutgoingWork: vi.fn(options.outgoing ?? (() => false)),
    pendingTextMessages: vi.fn(() => {
      steps.push('read-unsent');
      return options.unsent?.() ?? [];
    }),
    stop: vi.fn(() =>
      defer(() => {
        steps.push('stop');
        return options.stopFails
          ? throwError(() => new Error('stop failed'))
          : of(undefined);
      }),
    ),
    reset: vi.fn(),
    remove: vi.fn(),
    signOutAll: vi.fn(),
  };
  const closeAll = vi.fn(() => {
    steps.push('close-dialogs');
    if (options.closeFails) throw new Error('a dialog would not close');
  });
  const reload = vi.fn(() => {
    steps.push('reload');
  });
  const restart = vi.fn(() => {
    steps.push('restart-at-root');
  });
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
      MockProvider(MatrixClientService, matrix),
      MockProvider(TrnSurfaceService, { closeAll }),
      MockProvider(AppRestartService, { reload, restart }),
      MockProvider(UnsentDraftsWriter, { writeBack }),
    ],
  });
  const lifetime = TestBed.inject(SessionHandoverWorkflow).run().subscribe();
  return { steps, requests, matrix, reload, restart, writeBack, lifetime };
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
    expect(matrix.reset).not.toHaveBeenCalled();
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

  it('stops the clients after five seconds even if a send never settles', async () => {
    const { steps, requests, lifetime } = setup({ outgoing: () => true });

    requests.next();
    await vi.advanceTimersByTimeAsync(SESSION_HANDOVER_DRAIN_MS - 100);
    expect(steps).toEqual(['pause-sync']);
    await vi.advanceTimersByTimeAsync(200);

    expect(steps).toEqual(HANDED_OVER);
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
    writeBack.mockImplementationOnce(() => Promise.reject(new Error('quota')));

    requests.next();
    await vi.advanceTimersByTimeAsync(100);

    expect(steps.at(-1)).toBe('reload');
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
});
