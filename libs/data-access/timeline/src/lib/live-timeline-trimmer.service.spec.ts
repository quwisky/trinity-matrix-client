import { ErrorHandler, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ClientEvent,
  KnownMembership,
  MatrixEvent,
  Room,
  SyncState,
  createClient,
  type MatrixClient,
} from 'matrix-js-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { ConversationRuntime } from './conversation-runtime.service';
import { LiveTimelineTrimmer } from './live-timeline-trimmer.service';

const ALICE = '@alice:hs';
const OPEN = '!open:hs';

function setup() {
  const client = createClient({ baseUrl: 'https://hs', userId: ALICE });
  const room = new Room(OPEN, client, ALICE);
  room.updateMyMembership(KnownMembership.Join);
  client.store.storeRoom(room);
  const accountIds = signal<string[]>([]);
  const held = new Set([OPEN]);
  const errors = { handleError: vi.fn() };
  const trimHeld = vi.fn();
  const windowHidden = signal(false);
  TestBed.configureTestingModule({
    providers: [
      {
        provide: MatrixClientService,
        useValue: {
          accountIds: accountIds.asReadonly(),
          clientFor: (id: string) => (id === ALICE ? client : null),
        },
      },
      {
        provide: ConversationRuntime,
        useValue: {
          holds: (accountId: string, roomId: string) =>
            accountId === ALICE && held.has(roomId),
          trimHeld,
          windowHidden: windowHidden.asReadonly(),
          focused: signal({ key: { accountId: ALICE, roomId: OPEN } }),
        },
      },
      { provide: ErrorHandler, useValue: errors },
    ],
  });
  let received = 0;
  /** One sync of ten events into the open room. */
  const sync = async (target: MatrixClient = client) => {
    await room.addLiveEvents(
      Array.from(
        { length: 10 },
        (_, i) =>
          new MatrixEvent({
            event_id: `$${received + i}`,
            room_id: OPEN,
            type: 'm.room.message',
            sender: '@bob:hs',
            content: { msgtype: 'm.text', body: 'x' },
          }),
      ),
      { addToState: false },
    );
    received += 10;
    target.emit(ClientEvent.Sync, SyncState.Syncing, SyncState.Syncing, {
      nextSyncToken: `s${received}`,
    });
  };
  return {
    trimmer: TestBed.inject(LiveTimelineTrimmer),
    accountIds,
    errors,
    trimHeld,
    windowHidden,
    sync,
  };
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('LiveTimelineTrimmer', () => {
  it('leaves the focused room past the high-water mark to the Conversation runtime', async () => {
    const { trimmer, accountIds, trimHeld, sync } = setup();
    const running = trimmer.run().subscribe();
    accountIds.set([ALICE]);
    TestBed.tick();

    for (let i = 0; i < 20; i++) await sync();
    expect(trimHeld).not.toHaveBeenCalled();

    await sync();
    expect(trimHeld).toHaveBeenCalledExactlyOnceWith(ALICE, OPEN);
    running.unsubscribe();
  });

  it('trims the focused room as soon as the window is hidden, without waiting for a sync', async () => {
    const { trimmer, accountIds, trimHeld, windowHidden, sync } = setup();
    const running = trimmer.run().subscribe();
    accountIds.set([ALICE]);
    TestBed.tick();
    for (let i = 0; i < 21; i++) await sync();
    expect(trimHeld).toHaveBeenCalledOnce();

    windowHidden.set(true);
    TestBed.tick();

    expect(trimHeld).toHaveBeenCalledTimes(2);
    expect(trimHeld).toHaveBeenLastCalledWith(ALICE, OPEN);
    running.unsubscribe();
  });

  it('reports a failing open room once', async () => {
    const { trimmer, accountIds, errors, trimHeld, windowHidden, sync } =
      setup();
    const failure = new Error('broken open room');
    trimHeld.mockImplementation(() => {
      throw failure;
    });
    const running = trimmer.run().subscribe();
    accountIds.set([ALICE]);
    TestBed.tick();

    for (let i = 0; i < 25; i++) await sync();
    windowHidden.set(true);
    TestBed.tick();
    windowHidden.set(false);
    TestBed.tick();
    windowHidden.set(true);
    TestBed.tick();

    expect(trimHeld).toHaveBeenCalledOnce();
    expect(errors.handleError).toHaveBeenCalledExactlyOnceWith(failure);
    running.unsubscribe();
  });

  it('stops when its run ends or the Account goes away', async () => {
    const { trimmer, accountIds, trimHeld, sync } = setup();
    accountIds.set([ALICE]);
    const running = trimmer.run().subscribe();
    TestBed.tick();
    accountIds.set([]);
    TestBed.tick();
    for (let i = 0; i < 25; i++) await sync();

    accountIds.set([ALICE]);
    TestBed.tick();
    running.unsubscribe();
    await sync();

    expect(trimHeld).not.toHaveBeenCalled();
  });
});
