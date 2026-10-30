import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IgnoredUsersService } from './ignored-users.service';
import {
  ME,
  OFFLINE,
  identityFixture,
  sessionWith,
} from './identity.spec-harness';

const OTHER = '@other:hs';

function setup(ignored: readonly string[] = []) {
  const fixture = identityFixture([ME, OTHER]);
  fixture.engine.ignored.set(ME, ignored);
  TestBed.configureTestingModule({ providers: fixture.providers });
  const svc = TestBed.inject(IgnoredUsersService);
  const run = () => {
    const lifetime = svc.runProjection().subscribe();
    TestBed.tick();
    return lifetime;
  };
  return { ...fixture, svc, run };
}

/** Lets a queued reconcile run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  TestBed.tick();
}

describe('IgnoredUsersService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('projects the ignore list while its projection runs', () => {
    const { svc, run } = setup(['@bob:hs']);

    expect(svc.ignoredUserIds()).toEqual([]);
    const lifetime = run();

    expect(svc.ignoredUserIds()).toEqual(['@bob:hs']);
    expect(svc.isIgnored('@bob:hs')).toBe(true);
    expect(svc.isIgnored('@eve:hs')).toBe(false);

    lifetime.unsubscribe();
    expect(svc.ignoredUserIds()).toEqual([]);
  });

  it('follows a change made on another device', async () => {
    const { svc, engine, run } = setup(['@bob:hs']);
    const lifetime = run();

    engine.ignored.set(ME, ['@bob:hs', '@eve:hs']);
    engine.changed();
    await settle();

    expect(svc.ignoredUserIds()).toEqual(['@bob:hs', '@eve:hs']);
    lifetime.unsubscribe();
  });

  it('re-projects the newly active account after a switch', async () => {
    const { svc, engine, session, run } = setup(['@bob:hs']);
    engine.ignored.set(OTHER, ['@carol:hs']);
    const lifetime = run();

    session.set(sessionWith(OTHER, [ME, OTHER]));
    TestBed.tick();
    await settle();

    expect(svc.ignoredUserIds()).toEqual(['@carol:hs']);
    lifetime.unsubscribe();
  });

  it('names a blocked user only when this account already knows them', () => {
    const { svc, engine, run } = setup(['@bob:hs', '@eve:hs']);
    engine.profiles.set('@bob:hs', {
      displayName: 'Bob',
      avatarMxc: 'mxc://hs/bob',
    });
    const lifetime = run();

    expect(svc.ignoredUsers()).toEqual([
      { userId: '@bob:hs', displayName: 'Bob', avatarMxc: 'mxc://hs/bob' },
      { userId: '@eve:hs', displayName: null, avatarMxc: null },
    ]);
    lifetime.unsubscribe();
  });

  it('follows a blocked user renaming themselves', async () => {
    const { svc, engine, run } = setup(['@bob:hs']);
    engine.profiles.set('@bob:hs', { displayName: 'Bob', avatarMxc: null });
    const lifetime = run();

    engine.profiles.set('@bob:hs', { displayName: 'Robert', avatarMxc: null });
    engine.changed();
    await settle();

    expect(svc.ignoredUsers()[0].displayName).toBe('Robert');
    lifetime.unsubscribe();
  });

  it('ignore is cold and adds the user to the active account’s list on subscribe', async () => {
    const { svc, engine } = setup(['@existing:hs']);
    const write = vi.spyOn(engine, 'setIgnored');

    const action = svc.ignore('@bob:hs');
    expect(write).not.toHaveBeenCalled();

    await firstValueFrom(action);
    expect(write).toHaveBeenCalledWith(ME, '@bob:hs', true);
    expect(engine.ignored.get(ME)).toEqual(['@existing:hs', '@bob:hs']);
  });

  it('unignore removes the user from the list and the projection follows', async () => {
    const { svc, engine, run } = setup(['@bob:hs', '@eve:hs']);
    const lifetime = run();

    await firstValueFrom(svc.unignore('@bob:hs'));
    await settle();

    expect(engine.ignored.get(ME)).toEqual(['@eve:hs']);
    expect(svc.ignoredUserIds()).toEqual(['@eve:hs']);
    lifetime.unsubscribe();
  });

  it('is not ready without an active Account', async () => {
    const { svc, session } = setup();
    session.set(sessionWith(null, []));

    await expect(firstValueFrom(svc.ignore('@bob:hs'))).rejects.toMatchObject({
      operation: 'ignore-user',
      kind: 'not-ready',
    });
  });

  it('maps an unreached server to a typed retryable offline failure', async () => {
    const { svc, engine } = setup();
    engine.failure = OFFLINE;

    await expect(firstValueFrom(svc.ignore('@bob:hs'))).rejects.toMatchObject({
      operation: 'ignore-user',
      kind: 'offline',
      recovery: 'retry',
    });
    expect(engine.ignored.get(ME)).toEqual([]);
  });
});
