import { ApplicationRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ClientEvent } from 'matrix-js-sdk';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  INVITE_PERMISSION_EVENT,
  InvitePermissionService,
  UNSTABLE_INVITE_PERMISSION_EVENT,
} from './invite-permission.service';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

interface Server {
  versions?: string[];
  unstable?: Record<string, boolean>;
  fails?: boolean;
}

function fakeClient(
  userId: string,
  server: Server,
  data: Record<string, object> = {},
) {
  const listeners = new Map<string, Set<() => void>>();
  const store = new Map(Object.entries(data));
  const client = {
    getUserId: () => userId,
    getVersions: vi.fn(async () => {
      if (server.fails) throw new TypeError('offline');
      return {
        versions: server.versions ?? ['v1.12'],
        unstable_features: server.unstable ?? {},
      };
    }),
    getAccountData: (type: string) => {
      const content = store.get(type);
      return content ? { getContent: () => content } : undefined;
    },
    setAccountData: vi.fn(async (type: string, content: object) => {
      store.set(type, content);
      client.emit(ClientEvent.AccountData);
      return {};
    }),
    on(event: string, fn: () => void) {
      (listeners.get(event) ?? listeners.set(event, new Set()).get(event))?.add(
        fn,
      );
      return client;
    },
    off(event: string, fn: () => void) {
      listeners.get(event)?.delete(fn);
      return client;
    },
    emit(event: string) {
      for (const fn of listeners.get(event) ?? []) fn();
    },
    syncFromElsewhere(type: string, content: object) {
      store.set(type, content);
      client.emit(ClientEvent.AccountData);
    },
  };
  return client;
}

type FakeClient = ReturnType<typeof fakeClient>;

function setup(first: FakeClient) {
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
  };
  TestBed.configureTestingModule({
    providers: [
      InvitePermissionService,
      { provide: MatrixClientService, useValue: matrix },
    ],
  });
  const svc = TestBed.inject(InvitePermissionService);
  const switchTo = (next: FakeClient) => {
    instance.set(next);
    activeUserId.set(next.getUserId());
    TestBed.inject(ApplicationRef).tick();
  };
  return { svc, switchTo };
}

const STABLE_SERVER: Server = {
  unstable: { 'org.matrix.msc4380.stable': true },
};
const UNSTABLE_ONLY: Server = { unstable: { 'org.matrix.msc4380': true } };
const BOTH: Server = {
  versions: ['v1.18'],
  unstable: { 'org.matrix.msc4380': true },
};

describe('InvitePermissionService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('is unknown until the server answers, then supported through the .stable flag', async () => {
    const { svc } = setup(fakeClient('@me:hs', STABLE_SERVER));
    const lifetime = svc.runProjection().subscribe();

    expect(svc.supported()).toBeNull();
    await flush();

    expect(svc.supported()).toBe(true);
    expect(svc.blocked()).toBe(false);
    lifetime.unsubscribe();
  });

  it('supports a server that advertises spec v1.18 or later', async () => {
    const { svc } = setup(fakeClient('@me:hs', { versions: ['v1.19'] }));
    const lifetime = svc.runProjection().subscribe();
    await flush();

    expect(svc.supported()).toBe(true);
    lifetime.unsubscribe();
  });

  it('is unsupported when the server advertises neither', async () => {
    const { svc } = setup(fakeClient('@me:hs', { versions: ['v1.12'] }));
    const lifetime = svc.runProjection().subscribe();
    await flush();

    expect(svc.supported()).toBe(false);
    lifetime.unsubscribe();
  });

  it('stays unknown when /versions fails, rather than claiming no support', async () => {
    const { svc } = setup(fakeClient('@me:hs', { fails: true }));
    const lifetime = svc.runProjection().subscribe();
    await flush();

    expect(svc.supported()).toBeNull();
    lifetime.unsubscribe();
  });

  it('reads a block from the stable type', async () => {
    const { svc } = setup(
      fakeClient('@me:hs', STABLE_SERVER, {
        [INVITE_PERMISSION_EVENT]: { default_action: 'block' },
      }),
    );
    const lifetime = svc.runProjection().subscribe();
    await flush();

    expect(svc.blocked()).toBe(true);
    lifetime.unsubscribe();
  });

  it('reads a block from the unstable type on an unstable-only server', async () => {
    const { svc } = setup(
      fakeClient('@me:hs', UNSTABLE_ONLY, {
        [UNSTABLE_INVITE_PERMISSION_EVENT]: { default_action: 'block' },
      }),
    );
    const lifetime = svc.runProjection().subscribe();
    await flush();

    expect(svc.blocked()).toBe(true);
    lifetime.unsubscribe();
  });

  it('follows a change synced from another device', async () => {
    const client = fakeClient('@me:hs', STABLE_SERVER);
    const { svc } = setup(client);
    const lifetime = svc.runProjection().subscribe();
    await flush();

    client.syncFromElsewhere(INVITE_PERMISSION_EVENT, {
      default_action: 'block',
    });
    await flush();

    expect(svc.blocked()).toBe(true);
    lifetime.unsubscribe();
  });

  it('re-projects the newly active account after a switch', async () => {
    const { svc, switchTo } = setup(fakeClient('@me:hs', STABLE_SERVER));
    const lifetime = svc.runProjection().subscribe();
    await flush();

    switchTo(
      fakeClient(
        '@other:hs',
        { versions: ['v1.12'] },
        {
          [INVITE_PERMISSION_EVENT]: { default_action: 'block' },
        },
      ),
    );
    await flush();

    expect(svc.supported()).toBe(false);
    lifetime.unsubscribe();
  });

  it('blocks through the stable type and is cold', async () => {
    const client = fakeClient('@me:hs', STABLE_SERVER);
    const { svc } = setup(client);

    const action = svc.setBlocked(true);
    expect(client.setAccountData).not.toHaveBeenCalled();
    await firstValueFrom(action);

    expect(client.setAccountData).toHaveBeenCalledExactlyOnceWith(
      INVITE_PERMISSION_EVENT,
      { default_action: 'block' },
    );
  });

  it('falls back to the unstable type when only the unstable flag is advertised', async () => {
    const client = fakeClient('@me:hs', UNSTABLE_ONLY);
    const { svc } = setup(client);

    await firstValueFrom(svc.setBlocked(true));

    expect(client.setAccountData).toHaveBeenCalledExactlyOnceWith(
      UNSTABLE_INVITE_PERMISSION_EVENT,
      { default_action: 'block' },
    );
  });

  it('allowing clears both the stable type and a block left in the unstable slot', async () => {
    const client = fakeClient('@me:hs', BOTH, {
      [INVITE_PERMISSION_EVENT]: { default_action: 'block' },
      [UNSTABLE_INVITE_PERMISSION_EVENT]: { default_action: 'block' },
    });
    const { svc } = setup(client);
    const lifetime = svc.runProjection().subscribe();
    await flush();
    expect(svc.blocked()).toBe(true);

    await firstValueFrom(svc.setBlocked(false));
    await flush();

    expect(client.setAccountData).toHaveBeenCalledWith(
      INVITE_PERMISSION_EVENT,
      {},
    );
    expect(client.setAccountData).toHaveBeenCalledWith(
      UNSTABLE_INVITE_PERMISSION_EVENT,
      {},
    );
    expect(svc.blocked()).toBe(false);
    lifetime.unsubscribe();
  });

  it('allowing leaves an unstable slot alone when it holds no block', async () => {
    const client = fakeClient('@me:hs', STABLE_SERVER, {
      [INVITE_PERMISSION_EVENT]: { default_action: 'block' },
    });
    const { svc } = setup(client);

    await firstValueFrom(svc.setBlocked(false));

    expect(client.setAccountData).toHaveBeenCalledExactlyOnceWith(
      INVITE_PERMISSION_EVENT,
      {},
    );
  });

  it('refuses to write where the server has no invite blocking', async () => {
    const client = fakeClient('@me:hs', { versions: ['v1.12'] });
    const { svc } = setup(client);

    await expect(firstValueFrom(svc.setBlocked(true))).rejects.toThrow();
    expect(client.setAccountData).not.toHaveBeenCalled();
  });
});
