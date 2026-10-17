import { ApplicationRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ClientEvent } from 'matrix-js-sdk';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { IgnoredUsersService } from './ignored-users.service';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

function fakeClient(
  userId: string,
  ignored: string[] = [],
  names: Record<string, { displayName?: string; avatarUrl?: string }> = {},
) {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  let list = [...ignored];
  const client = {
    getUserId: () => userId,
    getIgnoredUsers: () => list,
    setIgnoredUsers: vi.fn(async (next: string[]) => {
      list = [...next];
      client.emit(ClientEvent.AccountData);
      return {};
    }),
    isUserIgnored: (id: string) => list.includes(id),
    getUser: (id: string) => (names[id] ? { userId: id, ...names[id] } : null),
    on(event: string, fn: (...args: unknown[]) => void) {
      (listeners.get(event) ?? listeners.set(event, new Set()).get(event))?.add(
        fn,
      );
      return client;
    },
    off(event: string, fn: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(fn);
      return client;
    },
    emit(event: string) {
      for (const fn of listeners.get(event) ?? []) fn();
    },
    /** Another device changed the list: only the sync echo arrives here. */
    replaceFromSync(next: string[]) {
      list = [...next];
      client.emit(ClientEvent.AccountData);
    },
  };
  return client;
}

function setup(first = fakeClient('@me:hs')) {
  const instance = signal(first);
  const activeUserId = signal<string | null>(first.getUserId());
  const matrix = {
    get isInitialized() {
      return activeUserId() !== null;
    },
    get instance() {
      return instance();
    },
    activeUserId: activeUserId.asReadonly(),
    accountIds: signal<readonly string[]>([first.getUserId()]).asReadonly(),
    clientFor: () => null,
  };
  TestBed.configureTestingModule({
    providers: [
      IgnoredUsersService,
      { provide: MatrixClientService, useValue: matrix },
    ],
  });
  const tick = () => TestBed.inject(ApplicationRef).tick();
  const switchTo = (next: ReturnType<typeof fakeClient>) => {
    instance.set(next);
    activeUserId.set(next.getUserId());
    tick();
  };
  return { svc: TestBed.inject(IgnoredUsersService), client: first, switchTo };
}

describe('IgnoredUsersService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('projects the ignore list while its projection runs', () => {
    const { svc } = setup(fakeClient('@me:hs', ['@bob:hs']));

    expect(svc.ignoredUserIds()).toEqual([]);
    const lifetime = svc.runProjection().subscribe();

    expect(svc.ignoredUserIds()).toEqual(['@bob:hs']);
    expect(svc.isIgnored('@bob:hs')).toBe(true);
    expect(svc.isIgnored('@eve:hs')).toBe(false);

    lifetime.unsubscribe();
    expect(svc.ignoredUserIds()).toEqual([]);
  });

  it('follows a change made on another device through account data', async () => {
    const { svc, client } = setup(fakeClient('@me:hs', ['@bob:hs']));
    const lifetime = svc.runProjection().subscribe();

    client.replaceFromSync(['@bob:hs', '@eve:hs']);
    await flush();

    expect(svc.ignoredUserIds()).toEqual(['@bob:hs', '@eve:hs']);
    lifetime.unsubscribe();
  });

  it('re-projects the newly active account after a switch', () => {
    const { svc, switchTo } = setup(fakeClient('@me:hs', ['@bob:hs']));
    const lifetime = svc.runProjection().subscribe();

    switchTo(fakeClient('@other:hs', ['@carol:hs']));

    expect(svc.ignoredUserIds()).toEqual(['@carol:hs']);
    lifetime.unsubscribe();
  });

  it('names a blocked user only when this account already knows them', () => {
    const { svc } = setup(
      fakeClient('@me:hs', ['@bob:hs', '@eve:hs'], {
        '@bob:hs': { displayName: 'Bob', avatarUrl: 'mxc://hs/bob' },
      }),
    );
    const lifetime = svc.runProjection().subscribe();

    expect(svc.ignoredUsers()).toEqual([
      { userId: '@bob:hs', displayName: 'Bob', avatarMxc: 'mxc://hs/bob' },
      { userId: '@eve:hs', displayName: null, avatarMxc: null },
    ]);
    lifetime.unsubscribe();
  });

  it('ignore is cold and appends the user to the list on subscribe', async () => {
    const { svc, client } = setup(fakeClient('@me:hs', ['@existing:hs']));

    const action = svc.ignore('@bob:hs');
    expect(client.setIgnoredUsers).not.toHaveBeenCalled();

    await firstValueFrom(action);
    expect(client.setIgnoredUsers).toHaveBeenCalledWith([
      '@existing:hs',
      '@bob:hs',
    ]);
  });

  it('ignore does not duplicate an already-ignored user', async () => {
    const { svc, client } = setup(fakeClient('@me:hs', ['@bob:hs']));

    await firstValueFrom(svc.ignore('@bob:hs'));

    expect(client.setIgnoredUsers).toHaveBeenCalledWith(['@bob:hs']);
  });

  it('unignore removes the user from the list and the projection follows', async () => {
    const { svc, client } = setup(fakeClient('@me:hs', ['@bob:hs', '@eve:hs']));
    const lifetime = svc.runProjection().subscribe();

    await firstValueFrom(svc.unignore('@bob:hs'));
    await flush();

    expect(client.setIgnoredUsers).toHaveBeenCalledWith(['@eve:hs']);
    expect(svc.ignoredUserIds()).toEqual(['@eve:hs']);
    lifetime.unsubscribe();
  });

  it('maps a network failure to a typed retryable offline failure', async () => {
    const { svc, client } = setup();
    client.setIgnoredUsers.mockRejectedValue(new TypeError('offline'));

    await expect(firstValueFrom(svc.ignore('@bob:hs'))).rejects.toMatchObject({
      operation: 'ignore-user',
      kind: 'offline',
      recovery: 'retry',
    });
  });
});
