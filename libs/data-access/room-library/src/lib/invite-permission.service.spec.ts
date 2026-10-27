import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject, firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_SESSION,
  SESSION_SNAPSHOT,
  type SessionAccountStatus,
  type SessionSnapshot,
} from '@trinity/data-access/matrix-client';
import { type EngineResult, engineOk } from '@trinity/util/matrix';
import { FakeRoomListEngine } from '../contract/fake-room-list-engine';
import { InvitePermissionService } from './invite-permission.service';
import { ROOM_LIST_ENGINE } from './room-list-engine.token';

function account(accountId: string, generation = 1): SessionAccountStatus {
  return {
    accountId,
    generation,
    syncState: 'syncing',
    serverSynced: true,
    roomsPrepared: true,
    waitingCount: 0,
    cryptoStoreEncrypted: true,
  };
}

/** The service over the fake engine with alice and bob live and alice active. */
function setup() {
  const fake = new FakeRoomListEngine();
  const { alice, bob } = fake;
  fake.seed(alice, []);
  fake.seed(bob, []);
  const session = signal<SessionSnapshot>({
    ...EMPTY_SESSION,
    activeAccountId: alice,
    accounts: [account(alice), account(bob)],
  });
  TestBed.configureTestingModule({
    providers: [
      { provide: ROOM_LIST_ENGINE, useValue: fake },
      { provide: SESSION_SNAPSHOT, useValue: session },
    ],
  });
  const svc = TestBed.inject(InvitePermissionService);
  const activate = (accountId: string | null, generation = 1): void => {
    session.set({
      ...EMPTY_SESSION,
      activeAccountId: accountId,
      accounts: [account(alice, generation), account(bob)],
    });
    TestBed.tick();
  };
  const run = () => {
    const lifetime = svc.runProjection().subscribe();
    TestBed.tick();
    return lifetime;
  };
  return { svc, fake, alice, bob, activate, run };
}

describe('InvitePermissionService', () => {
  it('is unknown until the projection runs, then reads the active account', () => {
    const { svc, run } = setup();
    expect(svc.supported()).toBeNull();

    const lifetime = run();

    expect(svc.supported()).toBe(true);
    expect(svc.blocked()).toBe(false);
    lifetime.unsubscribe();
    expect(svc.supported()).toBeNull();
  });

  it('is unsupported where the server has no invite blocking', () => {
    const { svc, fake, run } = setup();
    fake.serverBlocksInvites = false;

    const lifetime = run();

    expect(svc.supported()).toBe(false);
    expect(svc.blocked()).toBe(false);
    lifetime.unsubscribe();
  });

  it('follows a change made elsewhere', () => {
    const { svc, fake, alice, run } = setup();
    const lifetime = run();

    fake.setInviteBlocking(alice, true).subscribe();

    expect(svc.blocked()).toBe(true);
    lifetime.unsubscribe();
  });

  it('re-reads the newly active account after a switch', () => {
    const { svc, fake, alice, bob, activate, run } = setup();
    fake.setInviteBlocking(bob, true).subscribe();
    const lifetime = run();
    expect(svc.blocked()).toBe(false);

    activate(bob);
    expect(svc.blocked()).toBe(true);

    activate(null);
    expect(svc.supported()).toBeNull();
    activate(alice);
    expect(svc.blocked()).toBe(false);
    lifetime.unsubscribe();
  });

  it('re-subscribes for a new generation of the same account', () => {
    const { fake, alice, activate, run } = setup();
    const inviteBlocking = vi.spyOn(fake, 'inviteBlocking');
    const lifetime = run();

    activate(alice, 2);

    expect(inviteBlocking).toHaveBeenCalledTimes(2);
    lifetime.unsubscribe();
  });

  it('shares one engine subscription between its holders', () => {
    const { fake, run } = setup();
    const inviteBlocking = vi.spyOn(fake, 'inviteBlocking');

    const first = run();
    const second = run();

    expect(inviteBlocking).toHaveBeenCalledTimes(1);
    first.unsubscribe();
    second.unsubscribe();
  });

  it('blocks through the engine and is cold', async () => {
    const { svc, fake, alice } = setup();
    const write = vi.spyOn(fake, 'setInviteBlocking');

    const action = svc.setBlocked(true);
    expect(write).not.toHaveBeenCalled();
    await firstValueFrom(action);

    expect(write).toHaveBeenCalledExactlyOnceWith(alice, true);
  });

  it('refuses to write where the server has no invite blocking', async () => {
    const { svc, fake } = setup();
    fake.serverBlocksInvites = false;

    await expect(firstValueFrom(svc.setBlocked(true))).rejects.toMatchObject({
      name: 'EngineRequestError',
      failure: { code: 'request-failed' },
    });
  });

  it('fails as not signed in with no active account, or once it stops being live', async () => {
    const { svc, fake, activate } = setup();
    activate(null);
    await expect(firstValueFrom(svc.setBlocked(true))).rejects.toThrow(
      'Not signed in.',
    );

    activate(fake.alice);
    fake.failNext('account-not-live');
    await expect(firstValueFrom(svc.setBlocked(true))).rejects.toThrow(
      'Not signed in.',
    );
  });

  it('queues writes, and a queued write still lands after its caller has gone', async () => {
    const { svc, fake, alice } = setup();
    const replies: Subject<EngineResult<null>>[] = [];
    const write = vi.spyOn(fake, 'setInviteBlocking').mockImplementation(() => {
      const reply = new Subject<EngineResult<null>>();
      replies.push(reply);
      return reply;
    });
    const settle = (): void => {
      const reply = replies.shift();
      reply?.next(engineOk(null));
      reply?.complete();
    };

    const first = firstValueFrom(svc.setBlocked(true));
    const second = svc.setBlocked(false).subscribe();
    await Promise.resolve();
    expect(write).toHaveBeenCalledTimes(1);

    second.unsubscribe();
    settle();
    await first;
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    settle();

    expect(write).toHaveBeenLastCalledWith(alice, false);
  });

  it('writes each choice to the account it was made on, even after a switch', async () => {
    const { svc, fake, alice, bob, activate } = setup();
    const write = vi.spyOn(fake, 'setInviteBlocking');

    // The choice is made on alice; the switch lands before anything subscribes to it.
    const choice = svc.setBlocked(true);
    activate(bob);
    await firstValueFrom(choice);
    await firstValueFrom(svc.setBlocked(false));

    expect(write.mock.calls).toEqual([
      [alice, true],
      [bob, false],
    ]);
  });
});
