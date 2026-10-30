import { TestBed } from '@angular/core/testing';
import { AvatarService } from '@trinity/data-access/media';
import { type EngineResult, engineOk } from '@trinity/util/matrix';
import { MockProvider } from 'ng-mocks';
import { Subject, firstValueFrom, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from './identity-engine';
import { IdentityService } from './identity.service';
import {
  ME,
  OFFLINE,
  SERVER_ERROR,
  identityFixture,
  sessionWith,
} from './identity.spec-harness';

function setup() {
  const fixture = identityFixture();
  const upload = vi.fn(() => of('mxc://hs/new'));
  TestBed.configureTestingModule({
    providers: [...fixture.providers, MockProvider(AvatarService, { upload })],
  });
  return { ...fixture, svc: TestBed.inject(IdentityService), upload };
}

describe('IdentityService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('loads the profile and exposes the raw mxc avatar', async () => {
    const { svc, engine } = setup();
    engine.profiles.set(ME, { displayName: 'Alice', avatarMxc: 'mxc://hs/a' });

    const profile = await firstValueFrom(svc.load());

    expect(profile).toEqual({
      userId: ME,
      displayName: 'Alice',
      avatarMxc: 'mxc://hs/a',
    });
    expect(svc.profile()).toEqual(profile);
  });

  it('returns a raw-empty display name and no avatar when unset', async () => {
    const { svc } = setup();

    const profile = await firstValueFrom(svc.load());

    expect(profile).toEqual({ userId: ME, displayName: '', avatarMxc: null });
    expect(svc.profile()).toEqual(profile);
  });

  it('maps a server failure to a typed safe failure', async () => {
    const { svc, engine } = setup();
    engine.failure = SERVER_ERROR;

    await expect(firstValueFrom(svc.load())).rejects.toMatchObject({
      operation: 'load-own-profile',
      kind: 'server-failure',
      recovery: 'retry',
    });
  });

  it('maps an unreached server to a retryable offline failure', async () => {
    const { svc, engine } = setup();
    engine.failure = OFFLINE;

    await expect(firstValueFrom(svc.lookup('@bob:hs'))).rejects.toMatchObject({
      operation: 'lookup-user',
      kind: 'offline',
      recovery: 'retry',
    });
  });

  it('is not ready without an active Account', async () => {
    const { svc, session } = setup();
    session.set(sessionWith(null, []));

    await expect(firstValueFrom(svc.load())).rejects.toMatchObject({
      operation: 'load-own-profile',
      kind: 'not-ready',
    });
  });

  it('sets the display name and patches the signal', async () => {
    const { svc, engine } = setup();
    await firstValueFrom(svc.load());

    await firstValueFrom(svc.setDisplayName('  Bob  '));

    expect(engine.profiles.get(ME)?.displayName).toBe('Bob');
    expect(svc.profile()?.displayName).toBe('Bob');
  });

  it('clears the display name (sends empty, settles to raw-empty)', async () => {
    const { svc, engine } = setup();
    engine.profiles.set(ME, { displayName: 'Alice', avatarMxc: null });
    await firstValueFrom(svc.load());

    await firstValueFrom(svc.setDisplayName('   '));

    expect(engine.profiles.get(ME)?.displayName).toBe('');
    expect(svc.profile()?.displayName).toBe('');
  });

  it('is cold: nothing is written until subscribed', () => {
    const { svc, engine } = setup();

    svc.setDisplayName('Bob');

    expect(engine.profiles.get(ME)?.displayName).toBeNull();
  });

  it('uploads then sets a new avatar and patches the signal', async () => {
    const { svc, engine, upload } = setup();
    await firstValueFrom(svc.load());
    const file = new File([new Uint8Array([1])], 'me.png', {
      type: 'image/png',
    });

    await firstValueFrom(svc.setAvatar(file));

    expect(upload).toHaveBeenCalledWith(file, ME);
    expect(engine.profiles.get(ME)?.avatarMxc).toBe('mxc://hs/new');
    expect(svc.profile()?.avatarMxc).toBe('mxc://hs/new');
  });

  it('fetches another user’s profile without touching the own-profile signal', async () => {
    const { svc, engine } = setup();
    engine.profiles.set('@bob:hs', {
      displayName: 'Bob',
      avatarMxc: 'mxc://hs/b',
    });

    expect(await firstValueFrom(svc.lookup('@bob:hs'))).toEqual({
      userId: '@bob:hs',
      displayName: 'Bob',
      avatarMxc: 'mxc://hs/b',
    });
    expect(svc.profile()).toBeNull();
  });

  it('resolves an empty profile for a user the homeserver has none for', async () => {
    const { svc } = setup();

    expect(await firstValueFrom(svc.lookup('@ghost:hs'))).toEqual({
      userId: '@ghost:hs',
      displayName: '@ghost:hs',
      avatarMxc: null,
    });
  });

  it('does not publish a stale own profile after the active Account changes', async () => {
    const { svc, engine, session } = setup();
    const reply = new Subject<EngineResult<UserProfile>>();
    vi.spyOn(engine, 'profile').mockReturnValue(reply);

    const load = firstValueFrom(svc.load());
    session.set(sessionWith('@other:hs', [ME, '@other:hs']));
    reply.next(engineOk({ displayName: 'Old Account', avatarMxc: null }));
    await load;

    expect(svc.profile()).toBeNull();
  });

  it('hides an already-loaded profile immediately when the active Account changes', async () => {
    const { svc, session } = setup();
    await firstValueFrom(svc.load());
    expect(svc.profile()?.userId).toBe(ME);

    session.set(sessionWith('@other:hs', [ME, '@other:hs']));

    expect(svc.profile()).toBeNull();
  });
});
