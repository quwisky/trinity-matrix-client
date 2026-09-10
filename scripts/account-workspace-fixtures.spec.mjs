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
});
