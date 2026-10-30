import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomActionPermissionError } from './room-action-permissions.service';
import { RoomAdministrationError } from './room-administration-error';
import { RoomAdministrationProjectionState } from './room-administration-projection-state.service';
import {
  administrationSession,
  roomWithAlice,
} from './room-administration.spec-harness';
import { RoomAliasesService } from './room-aliases.service';

const PRIMARY = '#primary:example.org';
const ALTERNATIVE = '#alternative:elsewhere';

/** Alice at `alicePower` in bob's room, optionally with a canonical alias bob set. */
async function setup({
  alicePower = 100,
  canonical,
}: {
  alicePower?: number;
  canonical?: Record<string, string | string[]>;
} = {}) {
  const session = administrationSession();
  const { engine } = session;
  const roomId = await roomWithAlice(engine);
  await engine.asBob.setPowerLevel(roomId, engine.alice, alicePower);
  if (canonical) {
    await engine.asBob.setState(roomId, 'm.room.canonical_alias', canonical);
  }
  TestBed.configureTestingModule({ providers: session.providers });
  const state = TestBed.inject(RoomAdministrationProjectionState);
  state.select(engine.alice, roomId);
  state.update('permissions', 'available', 'retained');
  const target = { accountId: engine.alice, roomId };
  const aliases = async () => {
    const result = await firstValueFrom(
      engine.localAliases(engine.alice, roomId),
    );
    return result.ok ? result.value : null;
  };
  return {
    ...session,
    target,
    aliases,
    svc: TestBed.inject(RoomAliasesService),
  };
}

const failure = (action: Promise<unknown>) =>
  action.then(
    () => null,
    (error: unknown) => error,
  );

afterEach(() => TestBed.resetTestingModule());

describe('RoomAliasesService', () => {
  it('serverName is the domain of a signed-in account', async () => {
    const { svc, target } = await setup();

    expect(svc.serverName(target)).toBe('example.org');
    expect(
      svc.serverName({ accountId: '@gone:hs', roomId: target.roomId }),
    ).toBeNull();
  });

  it('localAliases is cold and returns the directory aliases', async () => {
    const { svc, engine, target } = await setup();
    await firstValueFrom(
      engine.publishAlias(engine.alice, target.roomId, '#a:example.org'),
    );
    const localAliases = vi.spyOn(engine, 'localAliases');

    const action = svc.localAliases(target);
    expect(localAliases).not.toHaveBeenCalled();

    expect(await firstValueFrom(action)).toEqual(['#a:example.org']);
    expect(localAliases).toHaveBeenCalledWith(engine.alice, target.roomId);
  });

  it('localAliases refuses an account that is not signed in', async () => {
    const { svc, target } = await setup();

    const error = await failure(
      firstValueFrom(
        svc.localAliases({ accountId: '@gone:hs', roomId: target.roomId }),
      ),
    );

    expect((error as RoomAdministrationError).outcome).toMatchObject({
      failure: 'not-signed-in',
      operation: 'load-aliases',
    });
  });

  it('addAlias is cold and publishes the alias on subscribe', async () => {
    const { svc, target, aliases } = await setup();

    const action = svc.addAlias(target, '#new:example.org');
    expect(await aliases()).toEqual([]);

    await firstValueFrom(action, { defaultValue: undefined });
    expect(await aliases()).toEqual(['#new:example.org']);
  });

  it('removeAlias is cold and deletes the alias on subscribe', async () => {
    const { svc, target, aliases } = await setup();
    await firstValueFrom(svc.addAlias(target, '#old:example.org'));

    const action = svc.removeAlias(target, '#old:example.org');
    expect(await aliases()).toEqual(['#old:example.org']);

    await firstValueFrom(action, { defaultValue: undefined });
    expect(await aliases()).toEqual([]);
  });

  it('clears a primary address before removing it from the directory', async () => {
    const { svc, engine, target } = await setup({
      canonical: { alias: PRIMARY, alt_aliases: [ALTERNATIVE] },
    });
    await firstValueFrom(svc.addAlias(target, PRIMARY));
    const setState = vi.spyOn(engine, 'setState');
    const removeAlias = vi.spyOn(engine, 'removeAlias');

    await firstValueFrom(svc.removeAlias(target, PRIMARY));

    expect(setState).toHaveBeenCalledExactlyOnceWith(
      engine.alice,
      target.roomId,
      'm.room.canonical_alias',
      '',
      { alt_aliases: [ALTERNATIVE] },
    );
    expect(setState.mock.invocationCallOrder[0]).toBeLessThan(
      removeAlias.mock.invocationCallOrder[0],
    );
    expect(svc.currentCanonical(target)).toBeNull();
  });

  it('reports the cleared primary address when the removal then fails', async () => {
    const { svc, target } = await setup({ canonical: { alias: PRIMARY } });

    // Never published, so the directory has nothing to remove.
    const error = await failure(
      firstValueFrom(svc.removeAlias(target, PRIMARY)),
    );

    expect((error as RoomAdministrationError).outcome).toMatchObject({
      failure: 'partial-update',
      recovery: 'review-room-state',
      operation: 'remove-alias',
      completedStep: 'canonical-address-cleared',
    });
  });

  it('stops after clearing the primary address when the session changed', async () => {
    const { svc, engine, signIn, target } = await setup({
      canonical: { alias: PRIMARY },
    });
    await firstValueFrom(svc.addAlias(target, PRIMARY));
    const setState = engine.setState.bind(engine);
    vi.spyOn(engine, 'setState').mockImplementation((...args) => {
      signIn([engine.alice], { generation: 2 });
      return setState(...args);
    });
    const removeAlias = vi.spyOn(engine, 'removeAlias');

    const error = await failure(
      firstValueFrom(svc.removeAlias(target, PRIMARY)),
    );

    expect((error as RoomAdministrationError).outcome.failure).toBe(
      'not-signed-in',
    );
    expect(removeAlias).not.toHaveBeenCalled();
  });

  it('rechecks live permission before mutating an alias', async () => {
    const { svc, target, aliases } = await setup({ alicePower: 0 });

    const error = await failure(
      firstValueFrom(svc.addAlias(target, '#new:example.org')),
    );

    expect(error).toBeInstanceOf(RoomActionPermissionError);
    expect(await aliases()).toEqual([]);
  });

  it('setCanonicalAlias writes m.room.canonical_alias, keeping other keys', async () => {
    const { svc, engine, target } = await setup({
      canonical: { alias: '#old:example.org', alt_aliases: [ALTERNATIVE] },
    });
    const setState = vi.spyOn(engine, 'setState');

    await firstValueFrom(svc.setCanonicalAlias(target, '#main:example.org'));

    expect(setState).toHaveBeenCalledExactlyOnceWith(
      engine.alice,
      target.roomId,
      'm.room.canonical_alias',
      '',
      { alias: '#main:example.org', alt_aliases: [ALTERNATIVE] },
    );
    expect(svc.currentCanonical(target)).toBe('#main:example.org');
  });

  it('currentCanonical reads the canonical alias from state, or null', async () => {
    const set = await setup({ canonical: { alias: '#main:hs' } });
    expect(set.svc.currentCanonical(set.target)).toBe('#main:hs');
    TestBed.resetTestingModule();
    const unset = await setup();
    expect(unset.svc.currentCanonical(unset.target)).toBeNull();
  });

  it('canManageAliases follows the canonical-alias send permission', async () => {
    const allowed = await setup();
    expect(allowed.svc.canManageAliases(allowed.target)).toBe(true);
    TestBed.resetTestingModule();
    const denied = await setup({ alicePower: 0 });
    expect(denied.svc.canManageAliases(denied.target)).toBe(false);
  });
});
