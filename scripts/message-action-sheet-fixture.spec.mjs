import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createNodeAccount } = vi.hoisted(() => ({
  createNodeAccount: vi.fn(),
}));
vi.mock('../e2e/support/node-account.mts', () => ({ createNodeAccount }));
vi.mock('../e2e/support/synapse/start.mjs', () => ({
  SYNAPSE_HTTP: 'http://synapse.test',
}));
const { createAccountFixtures } =
  await import('../e2e/android/account-workspace-fixtures.mts');

const owner = {
  username: 'sheet-owner',
  userId: '@sheet-owner:test',
  password: 'private-password',
  homeserver: 'http://synapse.test',
};
const response = (body) => new Response(JSON.stringify(body), { status: 200 });

async function setup({
  duplicateIds = false,
  corruptReadyEvent = false,
  relations = [],
} = {}) {
  const requests = [];
  const events = new Map();
  const cleanups = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, options) => {
      const path = new URL(url).pathname;
      const payload = options.body ? JSON.parse(options.body) : undefined;
      requests.push({ path, method: options.method, payload });
      if (path.endsWith('/login'))
        return response({
          user_id: owner.userId,
          access_token: 'private-token',
        });
      if (path.endsWith('/createRoom'))
        return response({ room_id: '!sheet:test' });
      if (path.includes('/send/m.room.message/')) {
        const eventId = duplicateIds ? '$duplicate' : `$event-${events.size}`;
        events.set(eventId, {
          event_id: eventId,
          sender: owner.userId,
          type: 'm.room.message',
          content: payload,
        });
        return response({ event_id: eventId });
      }
      if (path.includes('/event/')) {
        const event = events.get(decodeURIComponent(path.split('/').at(-1)));
        return response(
          corruptReadyEvent
            ? { ...event, content: { msgtype: 'm.text', body: 'wrong target' } }
            : event,
        );
      }
      if (path.includes('/relations/')) return response({ chunk: relations });
      if (/\/(leave|forget|logout)$/u.test(path)) return response({});
      throw new Error(`Unexpected fixture request ${options.method} ${path}`);
    }),
  );
  const fixtures = createAccountFixtures(
    {
      cleanup: (_name, operation) => cleanups.push(operation),
      userLocalpart: (role) => `sheet-${role}`,
    },
    new AbortController().signal,
  );
  const account = await fixtures.account('owner');
  return { fixtures, account, requests, cleanups };
}

describe('message action sheet fixture', () => {
  beforeEach(() => createNodeAccount.mockResolvedValue(owner));
  afterEach(() => vi.unstubAllGlobals());

  it('seeds exactly 80 ordered fillers then one verified newest event', async () => {
    const { fixtures, account, requests, cleanups } = await setup();
    expect(fixtures.createMessageActionSheetHistory).toBeTypeOf('function');
    const history = await fixtures.createMessageActionSheetHistory(
      account,
      'Sheet v',
      'v',
      'owned-v',
    );
    const sends = requests.filter(({ path }) => path.includes('/send/'));
    expect(sends).toHaveLength(81);
    expect(sends.slice(0, 80).map(({ payload }) => payload)).toEqual(
      Array.from({ length: 80 }, (_, index) => ({
        msgtype: 'm.text',
        body: `sheet filler v ${index}`,
      })),
    );
    expect(sends[80].payload).toEqual({
      msgtype: 'm.text',
      body: 'act on me owned-v',
    });
    expect(new Set(sends.map(({ path }) => path)).size).toBe(81);
    expect(
      requests.filter(({ path }) => path.includes('/event/')),
    ).toHaveLength(81);
    expect(history).toEqual({
      roomId: '!sheet:test',
      roomName: 'Sheet v',
      targetEventId: '$event-80',
      targetBody: 'act on me owned-v',
      oldestFillerEventId: '$event-0',
      oldestFillerBody: 'sheet filler v 0',
      messageCount: 81,
    });
    expect(
      requests.find(({ path }) => path.endsWith('/createRoom')).payload,
    ).toEqual({ name: 'Sheet v', preset: 'private_chat' });
    expect(JSON.stringify(history)).not.toMatch(
      /private-token|private-password/u,
    );
    await cleanups[0]();
    expect(
      requests.slice(-3).map(({ path }) => path.split('/').at(-1)),
    ).toEqual(['leave', 'forget', 'logout']);
  });

  it('uses a fresh one-event private Room for a non-virtual stage', async () => {
    const { fixtures, account, requests } = await setup();
    expect(fixtures.createMessageActionSheetHistory).toBeTypeOf('function');
    const history = await fixtures.createMessageActionSheetHistory(
      account,
      'Sheet a',
      'a',
      'owned-a',
    );
    expect(requests.filter(({ path }) => path.includes('/send/'))).toHaveLength(
      1,
    );
    expect(history.messageCount).toBe(1);
    expect(history.targetEventId).toBe('$event-0');
    expect(history.oldestFillerEventId).toBeNull();
    expect(history.oldestFillerBody).toBeNull();
  });

  it.each([
    ['duplicate event IDs', { duplicateIds: true }],
    ['wrong server message body', { corruptReadyEvent: true }],
  ])(
    'rejects %s before claiming an exact ready fixture',
    async (_name, options) => {
      const { fixtures, account } = await setup(options);
      expect(fixtures.createMessageActionSheetHistory).toBeTypeOf('function');
      await expect(
        fixtures.createMessageActionSheetHistory(
          account,
          'Sheet v',
          'v',
          'owned-v',
        ),
      ).rejects.toThrow();
    },
  );

  it('keeps exact relation identity and ready status in sanitized server facts', async () => {
    const correct = {
      event_id: '$reaction',
      type: 'm.reaction',
      sender: owner.userId,
      content: {
        'm.relates_to': {
          rel_type: 'm.annotation',
          event_id: '$target',
          key: '👍',
        },
      },
    };
    const relations = [
      correct,
      { ...correct, sender: '@other:test' },
      { ...correct, type: 'm.room.message' },
      { ...correct, event_id: '' },
      {
        ...correct,
        content: {
          'm.relates_to': {
            rel_type: 'm.annotation',
            event_id: '$other',
            key: '❤',
          },
        },
      },
      {
        ...correct,
        unsigned: { redacted_because: { event_id: '$redaction' } },
      },
    ];
    const { fixtures, account, requests } = await setup({ relations });
    expect(fixtures.messageActionSheetReactionEvents).toBeTypeOf('function');
    const facts = await fixtures.messageActionSheetReactionEvents(
      account,
      '!sheet:test',
      '$target',
    );
    expect(facts).toEqual([
      {
        eventIdPresent: true,
        senderMatches: true,
        targetMatches: true,
        annotation: true,
        key: '👍',
        ready: true,
      },
      {
        eventIdPresent: true,
        senderMatches: false,
        targetMatches: true,
        annotation: true,
        key: '👍',
        ready: true,
      },
      {
        eventIdPresent: true,
        senderMatches: true,
        targetMatches: true,
        annotation: true,
        key: '👍',
        ready: false,
      },
      {
        eventIdPresent: false,
        senderMatches: true,
        targetMatches: true,
        annotation: true,
        key: '👍',
        ready: false,
      },
      {
        eventIdPresent: true,
        senderMatches: true,
        targetMatches: false,
        annotation: true,
        key: '❤',
        ready: true,
      },
      {
        eventIdPresent: true,
        senderMatches: true,
        targetMatches: true,
        annotation: true,
        key: '👍',
        ready: false,
      },
    ]);
    expect(requests.at(-1).path).toBe(
      '/_matrix/client/v1/rooms/!sheet%3Atest/relations/%24target/m.annotation/m.reaction',
    );
    expect(JSON.stringify(facts)).not.toMatch(
      /private-token|private-password|@sheet-owner|\$target|\$reaction/u,
    );
  });
});
