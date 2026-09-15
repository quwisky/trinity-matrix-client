import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createNodeAccount, fetchCalls } = vi.hoisted(() => ({
  createNodeAccount: vi.fn(),
  fetchCalls: [],
}));

vi.mock('../e2e/support/node-account.mts', () => ({ createNodeAccount }));
vi.mock('../e2e/support/synapse/start.mjs', () => ({
  SYNAPSE_HTTP: 'http://synapse.test',
}));

const { createAccountFixtures } =
  await import('../e2e/android/account-workspace-fixtures.mts');

function resources(cleanups = []) {
  return {
    cleanup: (_label, operation) => cleanups.push(operation),
    userLocalpart: (role) => `local-${role}`,
  };
}

function response(body = {}, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function account(role) {
  return {
    username: `user-${role}`,
    userId: `@user-${role}:test`,
    password: `password-${role}`,
    homeserver: 'http://synapse.test',
  };
}

describe('account workspace fixtures', () => {
  beforeEach(() => {
    createNodeAccount.mockReset();
    fetchCalls.length = 0;
  });

  it('shares one registration and waits for login across concurrent account callers', async () => {
    createNodeAccount.mockResolvedValue(account('alice'));
    let releaseLogin;
    globalThis.fetch = vi.fn((url, init) => {
      fetchCalls.push({ url, init });
      return new Promise((resolve) => {
        releaseLogin = () =>
          resolve(
            response({ user_id: '@user-alice:test', access_token: 'token' }),
          );
      });
    });
    const fixtures = createAccountFixtures(
      resources(),
      new AbortController().signal,
    );

    const first = fixtures.account('alice');
    const second = fixtures.account('alice');
    await Promise.resolve();
    expect(createNodeAccount).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(1);
    let settled = false;
    void second.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseLogin();
    await expect(Promise.all([first, second])).resolves.toEqual([
      account('alice'),
      account('alice'),
    ]);
  });

  it('runs all room cleanup before account logout after interleaved account and room work', async () => {
    createNodeAccount.mockImplementation(async (_resources, _signal, role) =>
      account(role),
    );
    globalThis.fetch = vi.fn(async (url, init) => {
      fetchCalls.push({ url, init });
      if (url.endsWith('/login')) {
        const body = JSON.parse(init.body);
        return response({
          user_id: `@${body.identifier.user}:test`,
          access_token: body.identifier.user,
        });
      }
      if (url.endsWith('/createRoom'))
        return response({ room_id: '!room:test' });
      return response({});
    });
    const cleanups = [];
    const fixtures = createAccountFixtures(
      resources(cleanups),
      new AbortController().signal,
    );
    const alice = await fixtures.account('alice');
    await fixtures.createRoom(alice, { name: 'Room' });
    const bob = await fixtures.account('bob');
    await fixtures.join(bob, '!room:test');

    await cleanups[0]();
    const paths = fetchCalls.map(({ url }) => new URL(url).pathname);
    const firstLogout = paths.indexOf('/_matrix/client/v3/logout');
    expect(firstLogout).toBeGreaterThan(-1);
    expect(
      paths
        .slice(0, firstLogout)
        .filter((path) => path.endsWith('/leave') || path.endsWith('/forget')),
    ).toEqual([
      '/_matrix/client/v3/rooms/!room%3Atest/leave',
      '/_matrix/client/v3/rooms/!room%3Atest/forget',
      '/_matrix/client/v3/rooms/!room%3Atest/leave',
      '/_matrix/client/v3/rooms/!room%3Atest/forget',
    ]);
    expect(
      paths.slice(firstLogout).filter((path) => path.endsWith('/logout')),
    ).toHaveLength(2);
  });

  it('aggregates cleanup failures while attempting every leave, forget, and logout', async () => {
    createNodeAccount.mockImplementation(async (_resources, _signal, role) =>
      account(role),
    );
    globalThis.fetch = vi.fn(async (url, init) => {
      fetchCalls.push({ url, init });
      if (url.endsWith('/login')) {
        const body = JSON.parse(init.body);
        return response({
          user_id: `@${body.identifier.user}:test`,
          access_token: body.identifier.user,
        });
      }
      if (url.endsWith('/createRoom'))
        return response({ room_id: '!room:test' });
      if (
        url.endsWith('/leave') &&
        init.headers.Authorization === 'Bearer user-alice'
      )
        return response({}, 500);
      return response({});
    });
    const cleanups = [];
    const fixtures = createAccountFixtures(
      resources(cleanups),
      new AbortController().signal,
    );
    const alice = await fixtures.account('alice');
    await fixtures.createRoom(alice, { name: 'Room' });
    const bob = await fixtures.account('bob');
    await fixtures.join(bob, '!room:test');

    await expect(cleanups[0]()).rejects.toBeInstanceOf(AggregateError);
    const paths = fetchCalls.map(({ url }) => new URL(url).pathname);
    expect(paths.filter((path) => path.endsWith('/leave'))).toHaveLength(2);
    expect(paths.filter((path) => path.endsWith('/forget'))).toHaveLength(2);
    expect(paths.filter((path) => path.endsWith('/logout'))).toHaveLength(2);
  });

  it('tolerates an explicitly ended membership while still forgetting and logging out', async () => {
    createNodeAccount.mockImplementation(async (_resources, _signal, role) =>
      account(role),
    );
    globalThis.fetch = vi.fn(async (url, init) => {
      fetchCalls.push({ url, init });
      if (url.endsWith('/login')) {
        const body = JSON.parse(init.body);
        return response({
          user_id: `@${body.identifier.user}:test`,
          access_token: body.identifier.user,
        });
      }
      if (url.endsWith('/createRoom'))
        return response({ room_id: '!room:test' });
      if (
        url.endsWith('/leave') &&
        init.headers.Authorization === 'Bearer user-bob'
      )
        return response({ errcode: 'M_FORBIDDEN' }, 403);
      return response({});
    });
    const cleanups = [];
    const fixtures = createAccountFixtures(
      resources(cleanups),
      new AbortController().signal,
    );
    const alice = await fixtures.account('alice');
    await fixtures.createRoom(alice, { name: 'Room' });
    const bob = await fixtures.account('bob');
    await fixtures.join(bob, '!room:test');
    fixtures.allowEndedMembershipCleanup(bob, '!room:test');

    await expect(cleanups[0]()).resolves.toBeUndefined();
    const paths = fetchCalls.map(({ url }) => new URL(url).pathname);
    expect(paths.filter((path) => path.endsWith('/leave'))).toHaveLength(2);
    expect(paths.filter((path) => path.endsWith('/forget'))).toHaveLength(2);
    expect(paths.filter((path) => path.endsWith('/logout'))).toHaveLength(2);
  });

  it('aggregates a leave 403 when the membership was not explicitly ended', async () => {
    createNodeAccount.mockImplementation(async (_resources, _signal, role) =>
      account(role),
    );
    globalThis.fetch = vi.fn(async (url, init) => {
      fetchCalls.push({ url, init });
      if (url.endsWith('/login')) {
        const body = JSON.parse(init.body);
        return response({
          user_id: `@${body.identifier.user}:test`,
          access_token: body.identifier.user,
        });
      }
      if (url.endsWith('/createRoom'))
        return response({ room_id: '!room:test' });
      if (
        url.endsWith('/leave') &&
        init.headers.Authorization === 'Bearer user-bob'
      )
        return response({ errcode: 'M_FORBIDDEN' }, 403);
      return response({});
    });
    const cleanups = [];
    const fixtures = createAccountFixtures(
      resources(cleanups),
      new AbortController().signal,
    );
    const alice = await fixtures.account('alice');
    await fixtures.createRoom(alice, { name: 'Room' });
    const bob = await fixtures.account('bob');
    await fixtures.join(bob, '!room:test');

    await expect(cleanups[0]()).rejects.toBeInstanceOf(AggregateError);
    const paths = fetchCalls.map(({ url }) => new URL(url).pathname);
    expect(paths.filter((path) => path.endsWith('/leave'))).toHaveLength(2);
    expect(paths.filter((path) => path.endsWith('/forget'))).toHaveLength(2);
    expect(paths.filter((path) => path.endsWith('/logout'))).toHaveLength(2);
  });

  it('uploads the supplied PNG bytes before updating the profile with the MXC URI', async () => {
    createNodeAccount.mockResolvedValue(account('avatar'));
    globalThis.fetch = vi.fn(async (url, init) => {
      fetchCalls.push({ url, init });
      if (url.endsWith('/login'))
        return response({
          user_id: '@user-avatar:test',
          access_token: 'token',
        });
      if (url.includes('/_matrix/media/v3/upload'))
        return response({ content_uri: 'mxc://test/avatar' });
      return response({});
    });
    const fixtures = createAccountFixtures(
      resources(),
      new AbortController().signal,
    );
    const owner = await fixtures.account('avatar');
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);

    await expect(fixtures.setProfileAvatar(owner, png)).resolves.toBe(
      'mxc://test/avatar',
    );

    const upload = fetchCalls.find(({ url }) =>
      url.includes('/_matrix/media/v3/upload'),
    );
    expect(upload.init.method).toBe('POST');
    expect(upload.init.headers).toEqual({
      Authorization: 'Bearer token',
      'Content-Type': 'image/png',
    });
    expect(new Uint8Array(await upload.init.body.arrayBuffer())).toEqual(png);
    expect(fetchCalls.map(({ url }) => new URL(url).pathname)).toEqual([
      '/_matrix/client/v3/login',
      '/_matrix/media/v3/upload',
      '/_matrix/client/v3/profile/%40user-avatar%3Atest/avatar_url',
    ]);
    expect(JSON.parse(fetchCalls[2].init.body)).toEqual({
      avatar_url: 'mxc://test/avatar',
    });
  });

  it('rejects an invalid upload response without updating the profile', async () => {
    createNodeAccount.mockResolvedValue(account('avatar'));
    globalThis.fetch = vi.fn(async (url, init) => {
      fetchCalls.push({ url, init });
      if (url.endsWith('/login'))
        return response({
          user_id: '@user-avatar:test',
          access_token: 'token',
        });
      return response({ content_uri: 'https://test/avatar' });
    });
    const fixtures = createAccountFixtures(
      resources(),
      new AbortController().signal,
    );
    const owner = await fixtures.account('avatar');

    await expect(
      fixtures.setProfileAvatar(owner, Uint8Array.of(1)),
    ).rejects.toThrow(/must be MXC/);
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[1].url).toContain('/_matrix/media/v3/upload');
  });

  it('reads exact room state and alias resolution without exposing the access token', async () => {
    createNodeAccount.mockResolvedValue(account('observer'));
    globalThis.fetch = vi.fn(async (url, init) => {
      fetchCalls.push({ url, init });
      if (url.endsWith('/login')) {
        return response({
          user_id: '@user-observer:test',
          access_token: 'secret-observer-token',
        });
      }
      if (url.includes('/state/m.room.topic')) {
        return response({ topic: 'Persisted topic' });
      }
      if (url.includes('/state/m.room.canonical_alias')) {
        return response({ alias: '#space:test' });
      }
      if (url.includes('/directory/room/')) {
        return response({ room_id: '!space:test' });
      }
      return response({}, 404);
    });
    const fixtures = createAccountFixtures(
      resources(),
      new AbortController().signal,
    );
    const observer = await fixtures.account('observer');

    const state = await fixtures.roomState(
      observer,
      '!space:test',
      'm.room.topic',
    );
    const alias = await fixtures.resolveRoomAlias(observer, '#space:test');
    const canonical = await fixtures.roomState(
      observer,
      '!space:test',
      'm.room.canonical_alias',
    );
    expect(state).toEqual({ topic: 'Persisted topic' });
    expect(alias).toBe('!space:test');
    expect(canonical).toEqual({ alias: '#space:test' });
    expect(fetchCalls.slice(1).map(({ url }) => new URL(url).pathname)).toEqual(
      [
        '/_matrix/client/v3/rooms/!space%3Atest/state/m.room.topic',
        '/_matrix/client/v3/directory/room/%23space%3Atest',
        '/_matrix/client/v3/rooms/!space%3Atest/state/m.room.canonical_alias',
      ],
    );
    expect(JSON.stringify({ state, alias, canonical })).not.toContain(
      'secret-observer-token',
    );
  });

  it('reads joined room IDs through an authenticated GET without returning token fields', async () => {
    createNodeAccount.mockResolvedValue(account('owner'));
    globalThis.fetch = vi.fn(async (url, init) => {
      fetchCalls.push({ url, init });
      if (url.endsWith('/login'))
        return response({
          user_id: '@user-owner:test',
          access_token: 'secret-owner-token',
        });
      return response({
        joined_rooms: [
          '!parent:test',
          '!created-space:test',
          '!recovered-room:test',
        ],
        access_token: 'secret-owner-token',
      });
    });
    const fixtures = createAccountFixtures(
      resources(),
      new AbortController().signal,
    );
    const owner = await fixtures.account('owner');

    const ids = await fixtures.joinedRoomIds(owner);

    expect(ids).toEqual([
      '!parent:test',
      '!created-space:test',
      '!recovered-room:test',
    ]);
    expect(fetchCalls[1].url).toBe(
      'http://synapse.test/_matrix/client/v3/joined_rooms',
    );
    expect(fetchCalls[1].init.method).toBe('GET');
    expect(fetchCalls[1].init.headers).toEqual({
      Authorization: 'Bearer secret-owner-token',
    });
    expect(fetchCalls[1].init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify({ owner, ids })).not.toContain('secret-owner-token');
  });

  it('allows a separately bounded joined-room cleanup read after invocation cancellation', async () => {
    createNodeAccount.mockResolvedValue(account('owner'));
    globalThis.fetch = vi.fn(async (url, init) => {
      fetchCalls.push({ url, init });
      if (init.signal.aborted) throw new DOMException('aborted', 'AbortError');
      if (url.endsWith('/login'))
        return response({
          user_id: '@user-owner:test',
          access_token: 'secret-owner-token',
        });
      return response({ joined_rooms: ['!unlinked-created-room:test'] });
    });
    const invocation = new AbortController();
    const fixtures = createAccountFixtures(resources(), invocation.signal);
    const owner = await fixtures.account('owner');
    invocation.abort();

    await expect(fixtures.joinedRoomIds(owner)).rejects.toMatchObject({
      name: 'AbortError',
    });
    await expect(
      fixtures.joinedRoomIds(owner, AbortSignal.timeout(15_000)),
    ).resolves.toEqual(['!unlinked-created-room:test']);
    expect(fetchCalls.at(-1).init.signal.aborted).toBe(false);
  });

  it.each([
    ['missing list', {}],
    ['non-array list', { joined_rooms: 'secret-response' }],
    ['invalid room id', { joined_rooms: [42] }],
  ])(
    'rejects %s in joined-room discovery without revealing response fields',
    async (_label, body) => {
      createNodeAccount.mockResolvedValue(account('owner'));
      globalThis.fetch = vi.fn(async (url) =>
        url.endsWith('/login')
          ? response({
              user_id: '@user-owner:test',
              access_token: 'secret-owner-token',
            })
          : response(body),
      );
      const fixtures = createAccountFixtures(
        resources(),
        new AbortController().signal,
      );
      const owner = await fixtures.account('owner');

      await expect(fixtures.joinedRoomIds(owner)).rejects.toThrow(
        'Matrix fixture joined-room IDs must be strings',
      );
    },
  );

  it.each([
    ['Space link failure', ['!created-space:test']],
    [
      'recovery observation failure',
      ['!created-space:test', '!recovered-room:test'],
    ],
  ])(
    'discovers native creations after %s before leave/forget/logout despite cancellation',
    async (_label, createdIds) => {
      const { registerCreatedContentsCleanup } =
        await import('../e2e/android/space-settings-core-contents-journey.mts');
      createNodeAccount.mockResolvedValue(account('owner'));
      let joinedIds = ['!existing:test'];
      globalThis.fetch = vi.fn(async (url, init) => {
        fetchCalls.push({ url, init });
        if (init.signal.aborted)
          throw new DOMException('aborted', 'AbortError');
        if (url.endsWith('/login'))
          return response({
            user_id: '@user-owner:test',
            access_token: 'secret-owner-token',
          });
        if (url.endsWith('/joined_rooms'))
          return response({ joined_rooms: joinedIds });
        return response({});
      });
      const cleanups = [];
      const ownedResources = resources(cleanups);
      const invocation = new AbortController();
      const fixtures = createAccountFixtures(ownedResources, invocation.signal);
      const owner = await fixtures.account('owner');
      await registerCreatedContentsCleanup(
        { fixtures, resources: ownedResources },
        owner,
      );

      // Matrix has accepted creation, but no UI observation or explicit tracking succeeds.
      joinedIds = ['!existing:test', ...createdIds];
      invocation.abort();
      for (const cleanup of cleanups.toReversed()) await cleanup();

      const expectedCleanup = createdIds.flatMap((id) => [
        `/_matrix/client/v3/rooms/${encodeURIComponent(id)}/leave`,
        `/_matrix/client/v3/rooms/${encodeURIComponent(id)}/forget`,
      ]);
      expect(
        fetchCalls.slice(2).map(({ url }) => new URL(url).pathname),
      ).toEqual([
        '/_matrix/client/v3/joined_rooms',
        ...expectedCleanup,
        '/_matrix/client/v3/logout',
      ]);
      expect(
        fetchCalls.slice(2).every(({ init }) => !init.signal.aborted),
      ).toBe(true);
    },
  );

  it('writes keyed room state, preserves power levels, and reads extended state without tokens', async () => {
    createNodeAccount.mockResolvedValue(account('owner'));
    globalThis.fetch = vi.fn(async (url, init) => {
      fetchCalls.push({ url, init });
      if (url.endsWith('/login')) {
        return response({
          user_id: '@user-owner:test',
          access_token: 'secret-owner-token',
        });
      }
      if (init.method === 'GET' && url.endsWith('/state/m.room.power_levels')) {
        return response({
          ban: 50,
          events: { 'm.room.name': 50 },
          events_default: 0,
          invite: 0,
          kick: 50,
          redact: 50,
          state_default: 50,
          users: { '@owner:localhost': 100 },
          users_default: 0,
        });
      }
      if (init.method === 'GET' && url.endsWith('/state/m.room.avatar')) {
        return response({ url: 'mxc://localhost/avatar' });
      }
      if (init.method === 'GET' && url.endsWith('/state/m.room.join_rules')) {
        return response({ join_rule: 'invite' });
      }
      if (
        init.method === 'GET' &&
        url.endsWith('/state/m.space.parent/!parent%3Alocalhost')
      ) {
        return response({ canonical: true, via: ['localhost'] });
      }
      return response({});
    });
    const fixtures = createAccountFixtures(
      resources(),
      new AbortController().signal,
    );
    const owner = await fixtures.account('owner');

    await fixtures.setRoomState(owner, '!space:localhost', 'm.room.topic', {
      topic: 'Seed topic',
    });
    await fixtures.setRoomPower(
      owner,
      '!space:localhost',
      '@member:localhost',
      50,
    );
    const avatar = await fixtures.roomState(
      owner,
      '!space:localhost',
      'm.room.avatar',
    );
    const joinRules = await fixtures.roomState(
      owner,
      '!space:localhost',
      'm.room.join_rules',
    );
    const powerLevels = await fixtures.roomState(
      owner,
      '!space:localhost',
      'm.room.power_levels',
    );
    const parent = await fixtures.roomState(
      owner,
      '!space:localhost',
      'm.space.parent',
      '!parent:localhost',
    );

    expect([avatar, joinRules, powerLevels, parent]).toEqual([
      { url: 'mxc://localhost/avatar' },
      { join_rule: 'invite' },
      {
        ban: 50,
        events: { 'm.room.name': 50 },
        events_default: 0,
        invite: 0,
        kick: 50,
        redact: 50,
        state_default: 50,
        users: { '@owner:localhost': 100 },
        users_default: 0,
      },
      { canonical: true, via: ['localhost'] },
    ]);
    expect(fetchCalls.slice(1).map(({ url }) => new URL(url).pathname)).toEqual(
      [
        '/_matrix/client/v3/rooms/!space%3Alocalhost/state/m.room.topic',
        '/_matrix/client/v3/rooms/!space%3Alocalhost/state/m.room.power_levels',
        '/_matrix/client/v3/rooms/!space%3Alocalhost/state/m.room.power_levels',
        '/_matrix/client/v3/rooms/!space%3Alocalhost/state/m.room.avatar',
        '/_matrix/client/v3/rooms/!space%3Alocalhost/state/m.room.join_rules',
        '/_matrix/client/v3/rooms/!space%3Alocalhost/state/m.room.power_levels',
        '/_matrix/client/v3/rooms/!space%3Alocalhost/state/m.space.parent/!parent%3Alocalhost',
      ],
    );
    expect(JSON.parse(fetchCalls[1].init.body)).toEqual({
      topic: 'Seed topic',
    });
    expect(JSON.parse(fetchCalls[3].init.body)).toEqual({
      ban: 50,
      events: { 'm.room.name': 50 },
      events_default: 0,
      invite: 0,
      kick: 50,
      redact: 50,
      state_default: 50,
      users: { '@owner:localhost': 100, '@member:localhost': 50 },
      users_default: 0,
    });
    expect(
      JSON.stringify({ avatar, joinRules, powerLevels, parent }),
    ).not.toContain('secret-owner-token');
  });

  it('rejects an HTTP upload failure without updating the profile and still logs out', async () => {
    createNodeAccount.mockResolvedValue(account('avatar'));
    globalThis.fetch = vi.fn(async (url, init) => {
      fetchCalls.push({ url, init });
      if (url.endsWith('/login'))
        return response({
          user_id: '@user-avatar:test',
          access_token: 'token',
        });
      if (url.includes('/_matrix/media/v3/upload')) return response({}, 500);
      return response({});
    });
    const cleanups = [];
    const fixtures = createAccountFixtures(
      resources(cleanups),
      new AbortController().signal,
    );
    const owner = await fixtures.account('avatar');

    await expect(
      fixtures.setProfileAvatar(owner, Uint8Array.of(1)),
    ).rejects.toThrow(/avatar upload failed with HTTP 500/);
    await expect(cleanups[0]()).resolves.toBeUndefined();
    const paths = fetchCalls.map(({ url }) => new URL(url).pathname);
    expect(paths).not.toContain(
      '/_matrix/client/v3/profile/%40user-avatar%3Atest/avatar_url',
    );
    expect(paths.filter((path) => path.endsWith('/logout'))).toHaveLength(1);
  });

  it('reads and writes marked-unread account data without exposing the access token', async () => {
    createNodeAccount.mockResolvedValue(account('unread'));
    let unread;
    globalThis.fetch = vi.fn(async (url, init) => {
      fetchCalls.push({ url, init });
      if (url.endsWith('/login')) {
        return response({
          user_id: '@user-unread:test',
          access_token: 'private-token',
        });
      }
      if (init.method === 'GET') {
        return unread === undefined ? response({}, 404) : response({ unread });
      }
      if (url.endsWith('/account_data/m.marked_unread')) {
        unread = JSON.parse(init.body).unread;
      }
      return response({});
    });
    const fixtures = createAccountFixtures(
      resources(),
      new AbortController().signal,
    );
    const owner = await fixtures.account('unread');

    await expect(fixtures.markedUnread(owner, '!room:test')).resolves.toBe(
      undefined,
    );
    await expect(
      fixtures.setMarkedUnread(owner, '!room:test', true),
    ).resolves.toBe(true);
    await expect(fixtures.markedUnread(owner, '!room:test')).resolves.toBe(
      true,
    );

    const accountDataCalls = fetchCalls.slice(1);
    expect(accountDataCalls.map(({ url }) => new URL(url).pathname)).toEqual([
      '/_matrix/client/v3/user/%40user-unread%3Atest/rooms/!room%3Atest/account_data/m.marked_unread',
      '/_matrix/client/v3/user/%40user-unread%3Atest/rooms/!room%3Atest/account_data/m.marked_unread',
      '/_matrix/client/v3/user/%40user-unread%3Atest/rooms/!room%3Atest/account_data/m.marked_unread',
    ]);
    expect(
      accountDataCalls.every(
        ({ init }) => init.headers.Authorization === 'Bearer private-token',
      ),
    ).toBe(true);
    expect(JSON.parse(accountDataCalls[1].init.body)).toEqual({ unread: true });
    expect(owner).not.toHaveProperty('token');
  });

  it('reads real room membership state without exposing the access token', async () => {
    createNodeAccount.mockResolvedValue(account('member'));
    let membership;
    globalThis.fetch = vi.fn(async (url, init) => {
      fetchCalls.push({ url, init });
      if (url.endsWith('/login')) {
        return response({
          user_id: '@user-member:test',
          access_token: 'private-token',
        });
      }
      return membership === undefined
        ? response({}, 404)
        : response({ membership });
    });
    const fixtures = createAccountFixtures(
      resources(),
      new AbortController().signal,
    );
    const observer = await fixtures.account('member');
    const target = account('target');

    await expect(
      fixtures.roomMembership(observer, '!room:test', target),
    ).resolves.toBeUndefined();
    membership = 'invite';
    await expect(
      fixtures.roomMembership(observer, '!room:test', target),
    ).resolves.toBe('invite');

    const stateCalls = fetchCalls.slice(1);
    expect(stateCalls.map(({ url }) => new URL(url).pathname)).toEqual([
      '/_matrix/client/v3/rooms/!room%3Atest/state/m.room.member/%40user-target%3Atest',
      '/_matrix/client/v3/rooms/!room%3Atest/state/m.room.member/%40user-target%3Atest',
    ]);
    expect(
      stateCalls.every(
        ({ init }) => init.headers.Authorization === 'Bearer private-token',
      ),
    ).toBe(true);
    expect(observer).not.toHaveProperty('token');
  });

  it('propagates an already-aborted invocation to the finite avatar upload and still logs out', async () => {
    createNodeAccount.mockResolvedValue(account('avatar'));
    const controller = new AbortController();
    globalThis.fetch = vi.fn(async (url, init) => {
      fetchCalls.push({ url, init });
      if (url.endsWith('/login'))
        return response({
          user_id: '@user-avatar:test',
          access_token: 'token',
        });
      if (init.signal.aborted) throw new DOMException('aborted', 'AbortError');
      return response({ content_uri: 'mxc://test/avatar' });
    });
    const cleanups = [];
    const fixtures = createAccountFixtures(
      resources(cleanups),
      controller.signal,
    );
    const owner = await fixtures.account('avatar');
    controller.abort();

    await expect(
      fixtures.setProfileAvatar(owner, Uint8Array.of(1)),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[1].init.signal.aborted).toBe(true);

    await expect(cleanups[0]()).resolves.toBeUndefined();
    expect(fetchCalls.at(-1).url).toContain('/_matrix/client/v3/logout');
  });

  it('creates and registers a direct room before joining and publishing m.direct', async () => {
    createNodeAccount.mockImplementation(async (_resources, _signal, role) =>
      account(role),
    );
    globalThis.fetch = vi.fn(async (url, init) => {
      fetchCalls.push({ url, init });
      if (url.endsWith('/login')) {
        const body = JSON.parse(init.body);
        return response({
          user_id: `@${body.identifier.user}:test`,
          access_token: body.identifier.user,
        });
      }
      if (url.endsWith('/createRoom')) return response({ room_id: '!dm:test' });
      return response({});
    });
    const cleanups = [];
    const fixtures = createAccountFixtures(
      resources(cleanups),
      new AbortController().signal,
    );
    const owner = await fixtures.account('owner');
    const partner = await fixtures.account('partner');

    await expect(fixtures.createDirectRoom(owner, partner)).resolves.toEqual({
      id: '!dm:test',
    });

    expect(fetchCalls.map(({ url }) => new URL(url).pathname)).toEqual([
      '/_matrix/client/v3/login',
      '/_matrix/client/v3/login',
      '/_matrix/client/v3/createRoom',
      '/_matrix/client/v3/rooms/!dm%3Atest/join',
      '/_matrix/client/v3/user/%40user-owner%3Atest/account_data/m.direct',
    ]);
    expect(JSON.parse(fetchCalls[2].init.body)).toEqual({
      preset: 'private_chat',
      invite: ['@user-partner:test'],
      is_direct: true,
    });
    expect(JSON.parse(fetchCalls[4].init.body)).toEqual({
      '@user-partner:test': ['!dm:test'],
    });

    await cleanups[0]();
    const cleanupPaths = fetchCalls
      .slice(5)
      .map(({ url }) => new URL(url).pathname);
    expect(cleanupPaths.filter((path) => path.endsWith('/leave'))).toHaveLength(
      2,
    );
    expect(
      cleanupPaths.filter((path) => path.endsWith('/forget')),
    ).toHaveLength(2);
    expect(
      cleanupPaths.filter((path) => path.endsWith('/logout')),
    ).toHaveLength(2);
  });

  it('keeps direct-room cleanup ownership when joining fails', async () => {
    createNodeAccount.mockImplementation(async (_resources, _signal, role) =>
      account(role),
    );
    globalThis.fetch = vi.fn(async (url, init) => {
      fetchCalls.push({ url, init });
      if (url.endsWith('/login')) {
        const body = JSON.parse(init.body);
        return response({
          user_id: `@${body.identifier.user}:test`,
          access_token: body.identifier.user,
        });
      }
      if (url.endsWith('/createRoom')) return response({ room_id: '!dm:test' });
      if (url.endsWith('/join')) return response({}, 500);
      return response({});
    });
    const cleanups = [];
    const fixtures = createAccountFixtures(
      resources(cleanups),
      new AbortController().signal,
    );
    const owner = await fixtures.account('owner');
    const partner = await fixtures.account('partner');

    await expect(fixtures.createDirectRoom(owner, partner)).rejects.toThrow(
      /join failed/,
    );
    await expect(cleanups[0]()).resolves.toBeUndefined();
    const cleanupPaths = fetchCalls
      .slice(4)
      .map(({ url }) => new URL(url).pathname);
    expect(cleanupPaths.filter((path) => path.endsWith('/leave'))).toHaveLength(
      1,
    );
    expect(
      cleanupPaths.filter((path) => path.endsWith('/forget')),
    ).toHaveLength(1);
    expect(
      cleanupPaths.filter((path) => path.endsWith('/logout')),
    ).toHaveLength(2);
  });

  it('keeps both direct-room members owned when m.direct publication fails', async () => {
    createNodeAccount.mockImplementation(async (_resources, _signal, role) =>
      account(role),
    );
    globalThis.fetch = vi.fn(async (url, init) => {
      fetchCalls.push({ url, init });
      if (url.endsWith('/login')) {
        const body = JSON.parse(init.body);
        return response({
          user_id: `@${body.identifier.user}:test`,
          access_token: body.identifier.user,
        });
      }
      if (url.endsWith('/createRoom')) return response({ room_id: '!dm:test' });
      if (url.endsWith('/account_data/m.direct')) return response({}, 500);
      return response({});
    });
    const cleanups = [];
    const fixtures = createAccountFixtures(
      resources(cleanups),
      new AbortController().signal,
    );
    const owner = await fixtures.account('owner');
    const partner = await fixtures.account('partner');

    await expect(fixtures.createDirectRoom(owner, partner)).rejects.toThrow(
      /account_data\/m.direct failed/,
    );
    await expect(cleanups[0]()).resolves.toBeUndefined();
    const cleanupPaths = fetchCalls
      .slice(5)
      .map(({ url }) => new URL(url).pathname);
    expect(cleanupPaths.filter((path) => path.endsWith('/leave'))).toHaveLength(
      2,
    );
    expect(
      cleanupPaths.filter((path) => path.endsWith('/forget')),
    ).toHaveLength(2);
    expect(
      cleanupPaths.filter((path) => path.endsWith('/logout')),
    ).toHaveLength(2);
  });
});
