import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { MatrixClient } from 'matrix-js-sdk';
import { MockProvider, ngMocks } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdentityService } from './identity.service';
import { MatrixClientService } from '@trinity/data-access/matrix-client';

/**
 * The fakes here implement only the slice of MatrixClient the service touches, so the
 * widening cast lives at this one visible seam rather than implicitly at every stub site.
 */
const asClient = (fake: object): MatrixClient =>
  fake as unknown as MatrixClient;

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    getUserId: vi.fn(() => '@me:hs'),
    getProfileInfo: vi
      .fn()
      .mockResolvedValue({ displayname: 'Alice', avatar_url: 'mxc://hs/a' }),
    setDisplayName: vi.fn().mockResolvedValue({}),
    setAvatarUrl: vi.fn().mockResolvedValue({}),
    uploadContent: vi.fn().mockResolvedValue({ content_uri: 'mxc://hs/new' }),
    searchUserDirectory: vi.fn().mockResolvedValue({
      results: [
        {
          user_id: '@bob:hs',
          display_name: 'Bob',
          avatar_url: 'mxc://hs/b',
        },
        { user_id: '@eve:hs' },
      ],
    }),
    ...overrides,
  };
}

function setup(clientOverrides: Record<string, unknown> = {}) {
  const client = fakeClient(clientOverrides);
  const activeUserId = signal<string | null>('@me:hs');
  TestBed.configureTestingModule({
    providers: [
      IdentityService,
      MockProvider(MatrixClientService, {
        activeUserId: activeUserId.asReadonly(),
      }),
    ],
  });
  const matrix = TestBed.inject(MatrixClientService);
  // The service reads `matrix.instance` (a getter) for the SDK client; stub both
  // getters on the mock so it hands back our fake client.
  ngMocks.stubMember(matrix, 'instance', asClient(client));
  ngMocks.stubMember(matrix, 'isInitialized', true);
  ngMocks.stubMember(matrix, 'clientFor', () => asClient(client));
  return { svc: TestBed.inject(IdentityService), client, activeUserId };
}

describe('IdentityService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('loads the profile and exposes the raw mxc avatar', async () => {
    const { svc, client } = setup();

    const profile = await firstValueFrom(svc.load());

    expect(client.getProfileInfo).toHaveBeenCalledWith('@me:hs');
    expect(profile).toMatchObject({
      userId: '@me:hs',
      displayName: 'Alice',
      avatarMxc: 'mxc://hs/a',
    });
    expect(svc.profile()).toEqual(profile); // mirrored into the signal
  });

  it('returns a raw-empty display name and no avatar when unset', async () => {
    const { svc } = setup({
      getProfileInfo: vi.fn().mockResolvedValue({}),
    });

    const profile = await firstValueFrom(svc.load());

    expect(profile.displayName).toBe(''); // raw; the UI renders `|| userId`
    expect(profile.avatarMxc).toBeNull();
  });

  it('treats a 404 (brand-new account) as an empty profile, not an error', async () => {
    const { svc } = setup({
      getProfileInfo: vi.fn().mockRejectedValue({ httpStatus: 404 }),
    });

    const profile = await firstValueFrom(svc.load());

    expect(profile).toMatchObject({
      userId: '@me:hs',
      displayName: '',
      avatarMxc: null,
    });
    expect(svc.profile()).toEqual(profile); // editor can still render + set one
  });

  it('maps a non-404 load failure to a typed safe failure', async () => {
    const { svc } = setup({
      getProfileInfo: vi.fn().mockRejectedValue({ httpStatus: 500 }),
    });

    await expect(firstValueFrom(svc.load())).rejects.toMatchObject({
      operation: 'load-own-profile',
      kind: 'server-failure',
      recovery: 'retry',
    });
  });

  it('sets the display name and patches the signal', async () => {
    const { svc, client } = setup();
    await firstValueFrom(svc.load());

    await firstValueFrom(svc.setDisplayName('  Bob  '));

    expect(client.setDisplayName).toHaveBeenCalledWith('Bob'); // trimmed
    expect(svc.profile()?.displayName).toBe('Bob');
  });

  it('clears the display name (sends empty, settles to raw-empty)', async () => {
    const { svc, client } = setup();
    await firstValueFrom(svc.load());

    await firstValueFrom(svc.setDisplayName('   '));

    expect(client.setDisplayName).toHaveBeenCalledWith('');
    expect(svc.profile()?.displayName).toBe(''); // raw; renders as the user id
  });

  it('uploads then sets a new avatar and patches the signal', async () => {
    const { svc, client } = setup();
    await firstValueFrom(svc.load());
    const file = new File([new Uint8Array([1])], 'me.png', {
      type: 'image/png',
    });

    await firstValueFrom(svc.setAvatar(file));

    expect(client.uploadContent).toHaveBeenCalledTimes(1);
    expect(client.setAvatarUrl).toHaveBeenCalledWith('mxc://hs/new');
    expect(svc.profile()?.avatarMxc).toBe('mxc://hs/new');
  });

  it('fetches another user’s profile without touching the own-profile signal', async () => {
    const { svc, client } = setup({
      getProfileInfo: vi
        .fn()
        .mockResolvedValue({ displayname: 'Bob', avatar_url: 'mxc://hs/b' }),
    });

    const profile = await firstValueFrom(svc.lookup('@bob:hs'));

    expect(client.getProfileInfo).toHaveBeenCalledWith('@bob:hs');
    expect(profile).toEqual({
      userId: '@bob:hs',
      displayName: 'Bob',
      avatarMxc: 'mxc://hs/b',
    });
    expect(svc.profile()).toBeNull(); // the signed-in profile is left untouched
  });

  it('resolves an empty profile for a user the homeserver has none for', async () => {
    const { svc } = setup({
      getProfileInfo: vi
        .fn()
        .mockRejectedValue({ httpStatus: 404, errcode: 'M_NOT_FOUND' }),
    });

    expect(await firstValueFrom(svc.lookup('@ghost:hs'))).toEqual({
      userId: '@ghost:hs',
      displayName: '@ghost:hs',
      avatarMxc: null,
    });
  });

  it('searches users independently of Room Library with safe fallbacks', async () => {
    const { svc, client } = setup();

    const results = await firstValueFrom(svc.search('  b  '));

    expect(client.searchUserDirectory).toHaveBeenCalledWith({ term: 'b' });
    expect(results).toEqual([
      { userId: '@bob:hs', displayName: 'Bob', avatarMxc: 'mxc://hs/b' },
      { userId: '@eve:hs', displayName: '@eve:hs', avatarMxc: null },
    ]);
  });

  it('short-circuits an empty search without touching the homeserver', async () => {
    const { svc, client } = setup();

    await expect(firstValueFrom(svc.search('   '))).resolves.toEqual([]);
    expect(client.searchUserDirectory).not.toHaveBeenCalled();
  });

  it('does not publish a stale own profile after the active Account changes', async () => {
    let resolveProfile!: (value: { displayname: string }) => void;
    const pending = new Promise<{ displayname: string }>((resolve) => {
      resolveProfile = resolve;
    });
    const { svc, activeUserId } = setup({
      getProfileInfo: vi.fn(() => pending),
    });

    const load = firstValueFrom(svc.load());
    activeUserId.set('@other:hs');
    resolveProfile({ displayname: 'Old Account' });
    await load;

    expect(svc.profile()).toBeNull();
  });

  it('hides an already-loaded profile immediately when the active Account changes', async () => {
    const { svc, activeUserId } = setup();
    await firstValueFrom(svc.load());
    expect(svc.profile()?.userId).toBe('@me:hs');

    activeUserId.set('@other:hs');

    expect(svc.profile()).toBeNull();
  });
});
