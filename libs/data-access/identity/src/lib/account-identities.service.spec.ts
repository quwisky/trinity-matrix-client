import { TestBed } from '@angular/core/testing';
import { finalize } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { AccountIdentitiesService } from './account-identities.service';
import { ME, identityFixture, sessionWith } from './identity.spec-harness';

const ALT = '@alt:hs';

function setup(accounts: readonly string[] = [ME, ALT]) {
  const fixture = identityFixture(accounts);
  const closed: string[] = [];
  const ownProfile = fixture.engine.ownProfile.bind(fixture.engine);
  const subscribe = vi
    .spyOn(fixture.engine, 'ownProfile')
    .mockImplementation((accountId) =>
      ownProfile(accountId).pipe(finalize(() => closed.push(accountId))),
    );
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: fixture.providers });
  const svc = TestBed.inject(AccountIdentitiesService);
  // The subscriptions are reconciled from a constructor effect, which has not run yet.
  TestBed.tick();
  /** The engine's account changed its own profile, as its sync reports. */
  const rename = (accountId: string, displayName: string | null) => {
    fixture.engine.profiles.set(accountId, {
      avatarMxc: fixture.engine.profiles.get(accountId)?.avatarMxc ?? null,
      displayName,
    });
    fixture.engine.changed();
  };
  return { ...fixture, svc, subscribe, closed, rename };
}

describe('AccountIdentitiesService', () => {
  it('reads every signed-in account’s own profile', () => {
    const { svc, engine } = setup();
    engine.profiles.set(ME, { displayName: 'Me', avatarMxc: 'mxc://hs/me' });
    engine.profiles.set(ALT, { displayName: 'Alt', avatarMxc: null });
    engine.changed();

    expect(svc.identityOf(ME)).toEqual({
      userId: ME,
      displayName: 'Me',
      avatarMxc: 'mxc://hs/me',
    });
    expect(svc.identityOf(ALT).displayName).toBe('Alt');
  });

  it('falls back to the user id before a profile has hydrated', () => {
    const { svc } = setup([ALT]);

    expect(svc.identityOf(ALT)).toEqual({
      userId: ALT,
      displayName: ALT,
      avatarMxc: null,
    });
  });

  it('follows a display-name change on the account it belongs to', () => {
    const { svc, rename } = setup();

    rename(ALT, 'Alice');

    expect(svc.identityOf(ALT).displayName).toBe('Alice');
    expect(svc.identityOf(ME).displayName).toBe(ME);
  });

  it('follows an avatar change that leaves the name alone', () => {
    const { svc, engine } = setup([ME]);
    engine.profiles.set(ME, { displayName: 'Me', avatarMxc: 'mxc://old' });
    engine.changed();

    engine.profiles.set(ME, { displayName: 'Me', avatarMxc: 'mxc://new' });
    engine.changed();

    expect(svc.identityOf(ME).avatarMxc).toBe('mxc://new');
  });

  it('falls back to the mxid for an EMPTY display name', () => {
    // Synapse hands back '' for a user with no displayname, so `??` would render a blank
    // name where `||` renders the mxid.
    const { svc, rename } = setup([ME]);

    rename(ME, '');

    expect(svc.identityOf(ME).displayName).toBe(ME);
  });

  it('holds the same map when a change leaves every profile alone', () => {
    const { svc, rename, engine } = setup();
    rename(ME, 'Me');
    const before = svc.identities();

    engine.changed();

    expect(svc.identities()).toBe(before);
  });

  it('lets go of an account that signs out', () => {
    const { svc, session, closed } = setup();

    session.set(sessionWith(ME, [ME]));
    TestBed.tick();

    expect(closed).toEqual([ALT]);
    expect([...svc.identities().keys()]).toEqual([ME]);
  });

  it('subscribes again when the same account gets a new client', () => {
    // Re-adding a signed-in account keeps its id and the account list, and starts a new
    // session generation: holding the old subscription would freeze that account.
    const { svc, session, subscribe, closed, rename } = setup([ME]);
    expect(subscribe).toHaveBeenCalledTimes(1);

    session.set(sessionWith(ME, [ME], 2));
    TestBed.tick();
    rename(ME, 'Newer');

    expect(closed).toEqual([ME]);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(svc.identityOf(ME).displayName).toBe('Newer');
  });

  it('picks up an account that signs in later', () => {
    const { svc, engine, session } = setup([ME]);
    engine.signIn(ALT, { displayName: 'Alt', avatarMxc: null });

    session.set(sessionWith(ME, [ME, ALT]));
    TestBed.tick();

    expect(svc.identityOf(ALT).displayName).toBe('Alt');
  });

  it('shows the user id while the account’s client is not live', () => {
    const { svc, engine, session } = setup([ME]);
    engine.profiles.set('@pending:hs', {
      displayName: 'Pending',
      avatarMxc: null,
    });

    session.set(sessionWith(ME, [ME, '@pending:hs']));
    TestBed.tick();

    expect(svc.identityOf('@pending:hs').displayName).toBe('@pending:hs');
  });
});
