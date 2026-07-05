import { TestBed } from '@angular/core/testing';
import { MockProvider, ngMocks } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProfileService } from './profile.service';
import { MatrixClientService } from '@trinity/data-access-matrix-client';

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    getUserId: vi.fn(() => '@me:hs'),
    getProfileInfo: vi
      .fn()
      .mockResolvedValue({ displayname: 'Alice', avatar_url: 'mxc://hs/a' }),
    setDisplayName: vi.fn().mockResolvedValue({}),
    setAvatarUrl: vi.fn().mockResolvedValue({}),
    uploadContent: vi.fn().mockResolvedValue({ content_uri: 'mxc://hs/new' }),
    ...overrides,
  };
}

function setup(clientOverrides: Record<string, unknown> = {}) {
  const client = fakeClient(clientOverrides);
  TestBed.configureTestingModule({
    providers: [ProfileService, MockProvider(MatrixClientService)],
  });
  const matrix = TestBed.inject(MatrixClientService);
  // The service reads `matrix.instance` (a getter) for the SDK client; stub both
  // getters on the mock so it hands back our fake client.
  ngMocks.stubMember(matrix, 'instance', client);
  ngMocks.stubMember(matrix, 'isInitialized', true);
  return { svc: TestBed.inject(ProfileService), client };
}

describe('ProfileService', () => {
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

  it('propagates a non-404 load failure', async () => {
    const { svc } = setup({
      getProfileInfo: vi.fn().mockRejectedValue({ httpStatus: 500 }),
    });

    await expect(firstValueFrom(svc.load())).rejects.toBeTruthy();
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
});
