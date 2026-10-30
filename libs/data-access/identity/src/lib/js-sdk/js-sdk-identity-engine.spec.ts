import { Injector } from '@angular/core';
import { EventEmitter } from 'node:events';
import {
  ClientEvent,
  ConnectionError,
  MatrixError,
  MatrixEvent,
  User,
} from 'matrix-js-sdk';
import { firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import { JsSdkIdentityEngine } from './js-sdk-identity-engine';

const ME = '@me:example.org';
const NOW = 1_800_000_000_000;

function receive(user: User, content: Record<string, unknown>): MatrixEvent {
  const event = new MatrixEvent({
    type: 'm.presence',
    sender: user.userId,
    content,
  });
  user.setPresenceEvent(event);
  return event;
}

// What the Synapse contract cannot reach: members the SDK seeds offline without presence,
// the user id the SDK holds as an unknown name, an own presence the server never sent, the
// status message the SDK keeps after it is cleared, a bare 404, malformed profile fields
// and a request that never reached the server.
function setup(users: User[]) {
  const client = Object.assign(new EventEmitter(), {
    getUser: (id: string) => users.find((user) => user.userId === id) ?? null,
    getUsers: () => users,
    getProfileInfo: vi.fn(),
  });
  const engine = Injector.create({
    providers: [
      {
        provide: JS_SDK_CLIENTS,
        useValue: { clientFor: (id: string) => (id === ME ? client : null) },
      },
      JsSdkIdentityEngine,
    ],
  }).get(JsSdkIdentityEngine);
  return { engine, client };
}

describe('JsSdkIdentityEngine', () => {
  afterEach(() => vi.useRealTimers());

  it('lists only users whose presence arrived, with their last activity', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const member = new User('@member:example.org');
    const away = new User('@away:example.org');
    receive(away, {
      presence: 'unavailable',
      status_msg: 'Away',
      last_active_ago: 5_000,
      currently_active: false,
    });
    const { engine, client } = setup([new User(ME), member, away]);
    const seen: unknown[] = [];
    const subscription = engine
      .presence(ME)
      .subscribe((users) => seen.push(users));

    const awayInfo = {
      userId: away.userId,
      presence: 'unavailable',
      statusMessage: 'Away',
      lastActiveAt: NOW - 5_000,
      currentlyActive: false,
    };
    expect(seen).toEqual([[awayInfo]]);

    client.emit(
      ClientEvent.Event,
      receive(member, { presence: 'online', currently_active: true }),
    );
    await Promise.resolve();
    subscription.unsubscribe();

    expect(seen.at(-1)).toEqual([
      {
        userId: member.userId,
        presence: 'online',
        statusMessage: null,
        lastActiveAt: null,
        currentlyActive: true,
      },
      awayInfo,
    ]);
  });

  it('reads no own name while the SDK holds only the user id, then each sync re-reads it', async () => {
    const own = new User(ME);
    const { engine, client } = setup([own]);
    const seen: unknown[] = [];
    const subscription = engine
      .ownProfile(ME)
      .subscribe((profile) => seen.push(profile));

    own.setDisplayName('Me');
    client.emit(ClientEvent.Sync);
    await Promise.resolve();
    subscription.unsubscribe();

    expect(seen).toEqual([
      { displayName: null, avatarMxc: null },
      { displayName: 'Me', avatarMxc: null },
    ]);
  });

  it('reports no own presence until the server sends it, and a cleared message as null', async () => {
    const own = new User(ME);
    const { engine } = setup([own]);

    expect(await firstValueFrom(engine.ownPresence(ME))).toEqual({
      ok: true,
      value: { presence: null, statusMessage: null },
    });
    receive(own, { presence: 'offline', status_msg: 'Gone' });
    expect(await firstValueFrom(engine.ownPresence(ME))).toEqual({
      ok: true,
      value: { presence: 'offline', statusMessage: 'Gone' },
    });
    // The SDK keeps 'Gone' in presenceStatusMsg.
    receive(own, { presence: 'online' });
    expect(await firstValueFrom(engine.ownPresence(ME))).toEqual({
      ok: true,
      value: { presence: 'online', statusMessage: null },
    });
  });

  it('reads a bare 404 as an empty profile and drops fields that are not strings', async () => {
    const { engine, client } = setup([]);
    client.getProfileInfo
      .mockRejectedValueOnce(new MatrixError({}, 404))
      .mockResolvedValueOnce({ displayname: 5, avatar_url: 'mxc://x/y' });

    expect(await firstValueFrom(engine.profile(ME, '@gone:x'))).toEqual({
      ok: true,
      value: { displayName: null, avatarMxc: null },
    });
    expect(await firstValueFrom(engine.profile(ME, '@odd:x'))).toEqual({
      ok: true,
      value: { displayName: null, avatarMxc: 'mxc://x/y' },
    });
  });

  it('fails as a network failure when the server was not reached', async () => {
    const { engine, client } = setup([]);
    client.getProfileInfo.mockRejectedValue(
      new ConnectionError('fetch failed', new TypeError('fetch failed')),
    );

    expect(await firstValueFrom(engine.profile(ME, '@x:x'))).toMatchObject({
      ok: false,
      failure: { code: 'request-failed', kind: 'network' },
    });
  });
});
