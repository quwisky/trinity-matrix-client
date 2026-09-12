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
