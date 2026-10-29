import { computed } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject, firstValueFrom, lastValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type EngineResult,
  type PresenceState,
  engineOk,
} from '@trinity/util/matrix';
import type { PresenceInfo } from './identity-engine';
import { IdentityPresenceService } from './identity-presence.service';
import { ME, identityFixture, sessionWith } from './identity.spec-harness';

const OTHER = '@other:hs';
const NOW = 1_700_000_000_000;

function setup() {
  const fixture = identityFixture([ME, OTHER]);
  TestBed.configureTestingModule({ providers: fixture.providers });
  const svc = TestBed.inject(IdentityPresenceService);
  const run = () => {
    const lifetime = svc.runProjection().subscribe();
    TestBed.tick();
    return lifetime;
  };
  /** Presence the server sent for `userId`; every account receives it. */
  const receive = (
    userId: string,
    info: Partial<Omit<PresenceInfo, 'userId'>> = {},
  ) => {
    fixture.engine.presences.set(userId, {
      presence: 'online',
      statusMessage: null,
      lastActiveAt: null,
      currentlyActive: false,
      ...info,
    });
    fixture.engine.changed();
  };
  return { ...fixture, svc, run, receive };
}

/** Lets a queued reconcile run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  TestBed.tick();
}

describe('IdentityPresenceService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('can register a presence view from a computed member row without writing signals during the read', async () => {
    const { svc, run, receive } = setup();
    receive('@online:hs');
    const lifetime = run();
    const row = computed(() => svc.presenceFor('@online:hs')());

    expect(row()).toBeNull();
    await settle();
    expect(row()).toBe('online');
    lifetime.unsubscribe();
  });

  it('reports the signed-in user as online even when the server never echoes our own presence', () => {
    const { svc, run } = setup();
    const state = svc.presenceFor(ME);
    expect(state()).toBeNull();

    run();

    expect(state()).toBe('online');
  });

  it('keeps the signed-in user online even if a self presence event says otherwise', async () => {
    const { svc, run, receive } = setup();
    const state = svc.presenceFor(ME);
    run();

    receive(ME, { presence: 'offline' });
    await settle();

    expect(state()).toBe('online');
  });

  it('seeds received presence and leaves unknown users unknown', () => {
    const { svc, run, receive } = setup();
    receive('@online:hs');
    const online = svc.presenceFor('@online:hs');
    const stranger = svc.presenceFor('@stranger:hs');

    run();

    expect(online()).toBe('online');
    expect(stranger()).toBeNull();
  });

  it('shows a room member the account never received presence for as unknown, not offline', () => {
    const { svc, run, engine } = setup();
    engine.profiles.set('@silent:hs', {
      displayName: 'Silent',
      avatarMxc: null,
    });
    const silent = svc.presenceFor('@silent:hs');

    run();

    expect(silent()).toBeNull();
  });

  it('memoizes the signal per user id', () => {
    const { svc } = setup();
    expect(svc.presenceFor('@a:hs')).toBe(svc.presenceFor('@a:hs'));
  });

  it('updates a tracked user’s signal when their presence changes', async () => {
    const { svc, run, receive } = setup();
    const state = svc.presenceFor('@a:hs');
    run();
    expect(state()).toBeNull();

    receive('@a:hs', { presence: 'online' });
    await settle();
    expect(state()).toBe('online');

    receive('@a:hs', { presence: 'unavailable' });
    await settle();
    expect(state()).toBe('unavailable');
  });

  it('re-projects onto the newly active account when the active account switches', async () => {
    const { svc, run, receive, session } = setup();
    receive(OTHER, { presence: 'offline' });
    const me = svc.presenceFor(ME);
    const other = svc.presenceFor(OTHER);
    run();
    expect([me(), other()]).toEqual(['online', 'offline']);

    session.set(sessionWith(OTHER, [ME, OTHER]));
    TestBed.tick();
    await settle();

    expect([me(), other()]).toEqual([null, 'online']);
  });

  it('subscribes again for a new session generation of the same account', async () => {
    const { svc, run, engine, session } = setup();
    const subscribe = vi.spyOn(engine, 'presence');
    const me = svc.presenceFor(ME);
    run();
    expect(subscribe).toHaveBeenCalledTimes(1);

    session.set(sessionWith(ME, [ME, OTHER], 2));
    TestBed.tick();
    await settle();

    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(me()).toBe('online');
  });

  it('is unknown for everyone while no projection is held', () => {
    const { svc, run, receive } = setup();
    receive('@a:hs');
    const state = svc.presenceFor('@a:hs');
    const lifetime = run();
    expect(state()).toBe('online');

    lifetime.unsubscribe();

    expect(state()).toBeNull();
    expect(svc.presenceAvailable()).toBe(false);
  });

  describe('presenceDetailsFor', () => {
    beforeEach(() => {
      vi.spyOn(Date, 'now').mockReturnValue(NOW);
    });

    it('exposes state, status message and last active time', () => {
      const { svc, run, receive } = setup();
      receive('@a:hs', {
        presence: 'unavailable',
        statusMessage: 'On holiday',
        lastActiveAt: NOW - 7_200_000,
      });
      const details = svc.presenceDetailsFor('@a:hs');

      run();

      expect(details()).toEqual({
        state: 'unavailable',
        statusMessage: 'On holiday',
        lastActiveAt: NOW - 7_200_000,
        currentlyActive: false,
      });
    });

    it("keeps the same object when another user's presence rebuilds the projection", async () => {
      const { svc, run, receive } = setup();
      receive('@a:hs', {
        presence: 'unavailable',
        lastActiveAt: NOW - 7_200_000,
      });
      const details = svc.presenceDetailsFor('@a:hs');
      run();
      const before = details();

      receive('@b:hs');
      await settle();

      expect(details()).toBe(before);
    });

    it('drops a status message the user cleared', async () => {
      const { svc, run, receive } = setup();
      receive('@a:hs', { statusMessage: 'brb' });
      const details = svc.presenceDetailsFor('@a:hs');
      run();
      expect(details()?.statusMessage).toBe('brb');

      receive('@a:hs', { statusMessage: null });
      await settle();

      expect(details()?.statusMessage).toBe('');
    });

    it('has no last active time when the server did not say', () => {
      const { svc, run, receive } = setup();
      receive('@a:hs');
      const details = svc.presenceDetailsFor('@a:hs');

      run();

      expect(details()).toMatchObject({ state: 'online', lastActiveAt: null });
    });

    it('keeps the signed-in user online without a presence event', () => {
      const { svc, run } = setup();
      const details = svc.presenceDetailsFor(ME);

      run();

      expect(details()).toEqual({
        state: 'online',
        statusMessage: '',
        lastActiveAt: null,
        currentlyActive: false,
      });
    });

    it('keeps the signed-in user online with the status message the server echoed', () => {
      const { svc, run, receive } = setup();
      receive(ME, { presence: 'unavailable', statusMessage: 'brb' });
      const details = svc.presenceDetailsFor(ME);

      run();

      expect(details()).toMatchObject({
        state: 'online',
        statusMessage: 'brb',
      });
    });

    it('is null for a user the account never received presence for', () => {
      const { svc, run } = setup();
      const details = svc.presenceDetailsFor('@ghost:hs');

      run();

      expect(details()).toBeNull();
    });

    it('is null while presence is unavailable', () => {
      const { svc, receive } = setup();
      receive('@a:hs');

      expect(svc.presenceDetailsFor('@a:hs')()).toBeNull();
    });

    it('updates when presence arrives', async () => {
      const { svc, run, receive } = setup();
      const details = svc.presenceDetailsFor('@a:hs');
      run();
      expect(details()).toBeNull();

      receive('@a:hs');
      await settle();

      expect(details()?.state).toBe('online');
    });

    it('resets to null when the projection is released', () => {
      const { svc, run, receive } = setup();
      receive('@a:hs');
      const details = svc.presenceDetailsFor('@a:hs');
      const lifetime = run();
      expect(details()).not.toBeNull();

      lifetime.unsubscribe();

      expect(details()).toBeNull();
    });
  });

  describe('own presence', () => {
    it('seeds myPresence and myStatusMessage from the server, then completes', async () => {
      const { svc, receive } = setup();
      receive(ME, { presence: 'unavailable', statusMessage: 'brb' });

      await lastValueFrom(svc.loadOwnPresence(), { defaultValue: undefined });

      expect(svc.myPresence()).toBe('unavailable');
      expect(svc.myStatusMessage()).toBe('brb');
    });

    it('is cold and completes only once a late answer has seeded the signals', () => {
      const { svc, engine } = setup();
      const answer = new Subject<
        EngineResult<{
          presence: PresenceState | null;
          statusMessage: string | null;
        }>
      >();
      const read = vi.spyOn(engine, 'ownPresence').mockReturnValue(answer);
      const load = svc.loadOwnPresence();
      expect(read).not.toHaveBeenCalled();

      let done = false;
      load.subscribe({ complete: () => (done = true) });
      expect([done, svc.myPresence()]).toEqual([false, 'online']);

      answer.next(engineOk({ presence: 'unavailable', statusMessage: 'brb' }));
      answer.complete();

      expect(done).toBe(true);
      expect(svc.myPresence()).toBe('unavailable');
      expect(svc.myStatusMessage()).toBe('brb');
    });

    it('defaults own presence to online when the server has not echoed it', () => {
      const { svc, engine } = setup();
      engine.presences.set(ME, {
        presence: 'unavailable',
        statusMessage: 'stale',
        lastActiveAt: null,
        currentlyActive: false,
      });
      svc.loadOwnPresence().subscribe();
      expect(svc.myPresence()).toBe('unavailable');

      engine.presences.delete(ME);
      svc.loadOwnPresence().subscribe();

      expect(svc.myPresence()).toBe('online');
      expect(svc.myStatusMessage()).toBe('');
    });

    it('completes without reading or changing own presence without an active Account', () => {
      const { svc, session, engine } = setup();
      const read = vi.spyOn(engine, 'ownPresence');
      session.set(sessionWith(null, []));
      let done = false;

      svc.loadOwnPresence().subscribe({ complete: () => (done = true) });

      expect(done).toBe(true);
      expect(read).not.toHaveBeenCalled();
      expect(svc.myPresence()).toBe('online');
    });

    it('publishes presence + trimmed status and updates the signals', async () => {
      const { svc, engine } = setup();
      const write = vi.spyOn(engine, 'setPresence');

      await firstValueFrom(svc.setOwnPresence('unavailable', '  heads down  '));

      expect(write).toHaveBeenCalledWith(ME, 'unavailable', 'heads down');
      expect(svc.myPresence()).toBe('unavailable');
      expect(svc.myStatusMessage()).toBe('heads down');
    });

    it('clears an empty status message', async () => {
      const { svc, engine } = setup();
      const write = vi.spyOn(engine, 'setPresence');

      await firstValueFrom(svc.setOwnPresence('offline', '   '));

      expect(write).toHaveBeenCalledWith(ME, 'offline', null);
      expect(svc.myStatusMessage()).toBe('');
    });

    it('clears own presence presentation when the projection disconnects', () => {
      const { svc, run, receive } = setup();
      receive(ME, { presence: 'unavailable', statusMessage: 'heads down' });
      const lifetime = run();
      svc.loadOwnPresence().subscribe();

      lifetime.unsubscribe();

      expect(svc.myPresence()).toBe('online');
      expect(svc.myStatusMessage()).toBe('');
    });

    it('does not publish a completed write into a newly active account', async () => {
      const { svc, engine, session } = setup();
      const reply = new Subject<EngineResult<null>>();
      vi.spyOn(engine, 'setPresence').mockReturnValue(reply);
      const pending = firstValueFrom(
        svc.setOwnPresence('unavailable', 'old account'),
      );

      session.set(sessionWith(OTHER, [ME, OTHER]));
      reply.next(engineOk(null));
      await pending;

      expect(svc.myPresence()).toBe('online');
      expect(svc.myStatusMessage()).toBe('');
    });

    it('is cold — nothing is sent until subscribed', () => {
      const { svc, engine } = setup();
      const write = vi.spyOn(engine, 'setPresence');

      svc.setOwnPresence('online', 'hi');

      expect(write).not.toHaveBeenCalled();
    });

    it('maps a disabled presence endpoint to an unavailable failure', async () => {
      const { svc, engine } = setup();
      engine.failure = {
        kind: 'http',
        code: 'request-failed',
        diagnostic: {
          kind: 'http',
          httpStatus: 400,
          errcode: 'M_UNRECOGNIZED',
        },
      };

      await expect(
        firstValueFrom(svc.setOwnPresence('online', 'hi')),
      ).rejects.toMatchObject({
        operation: 'set-presence',
        kind: 'unavailable',
        recovery: 'none',
      });
    });
  });
});
