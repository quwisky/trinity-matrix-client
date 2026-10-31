import { registerSynapseUser, synapseRequest } from '@trinity/testing';
import type { ConversationContentContractSetup } from './conversation-content-engine.contract';
import type { TimelineContractSetup } from './timeline-engine.contract';

type SynapseUser = Awaited<ReturnType<typeof registerSynapseUser>>;

const RECEIPT_TIMEOUT_MS = 30_000;

const room = (roomId: string) => `/rooms/${encodeURIComponent(roomId)}`;

let sequence = 0;

function localpart(role: string): string {
  sequence += 1;
  return `tl-${role}-${Date.now().toString(36)}-${sequence}-${Math.random().toString(36).slice(2, 6)}`;
}

const text = (body: string) => ({ msgtype: 'm.text', body });

const edit = (eventId: string, body: string) => ({
  msgtype: 'm.text',
  body: `* ${body}`,
  'm.new_content': text(body),
  'm.relates_to': { rel_type: 'm.replace', event_id: eventId },
});

async function register(baseUrl: string, secret: string) {
  return Promise.all([
    registerSynapseUser(baseUrl, secret, localpart('alice')),
    registerSynapseUser(baseUrl, secret, localpart('bob')),
  ]);
}

async function sendEvent(
  baseUrl: string,
  user: SynapseUser,
  roomId: string,
  type: string,
  content: unknown,
): Promise<string> {
  const { event_id } = await synapseRequest<{ event_id: string }>(
    baseUrl,
    user.accessToken,
    'PUT',
    `${room(roomId)}/send/${encodeURIComponent(type)}/${localpart('txn')}`,
    content,
  );
  return event_id;
}

async function invite(
  baseUrl: string,
  user: SynapseUser,
  roomId: string,
  userId: string,
): Promise<void> {
  await synapseRequest(
    baseUrl,
    user.accessToken,
    'POST',
    `${room(roomId)}/invite`,
    {
      user_id: userId,
    },
  );
}

async function join(
  baseUrl: string,
  user: SynapseUser,
  roomId: string,
): Promise<void> {
  await synapseRequest(
    baseUrl,
    user.accessToken,
    'POST',
    `${room(roomId)}/join`,
    {},
  );
}

/** The room's current `m.room.power_levels` content. */
function powerLevels(baseUrl: string, user: SynapseUser, roomId: string) {
  return synapseRequest<{
    events_default?: number;
    redact?: number;
    events?: Record<string, number>;
    users?: Record<string, number>;
  }>(
    baseUrl,
    user.accessToken,
    'GET',
    `${room(roomId)}/state/m.room.power_levels/`,
  );
}

function createRoom(
  baseUrl: string,
  user: SynapseUser,
  name: string,
  encrypted = false,
): Promise<string> {
  return synapseRequest<{ room_id: string }>(
    baseUrl,
    user.accessToken,
    'POST',
    '/createRoom',
    {
      name,
      preset: 'private_chat',
      initial_state: [
        {
          type: 'm.room.history_visibility',
          state_key: '',
          content: { history_visibility: 'shared' },
        },
        ...(encrypted
          ? [
              {
                type: 'm.room.encryption',
                state_key: '',
                content: { algorithm: 'm.megolm.v1.aes-sha2' },
              },
            ]
          : []),
      ],
    },
  ).then((created) => created.room_id);
}

/** The event `userId`'s `m.read` receipt names in the room, from an initial sync of that room. */
async function receiptIn(
  baseUrl: string,
  user: SynapseUser,
  roomId: string,
  userId: string,
): Promise<string | null> {
  const syncFilter = JSON.stringify({
    presence: { not_types: ['*'] },
    account_data: { not_types: ['*'] },
    room: {
      rooms: [roomId],
      timeline: { limit: 1 },
      state: { lazy_load_members: true },
      ephemeral: { types: ['m.receipt'] },
    },
  });
  const sync = await synapseRequest<{
    rooms?: {
      join?: Record<
        string,
        { ephemeral?: { events?: { type: string; content: unknown }[] } }
      >;
    };
  }>(
    baseUrl,
    user.accessToken,
    'GET',
    `/sync?filter=${encodeURIComponent(syncFilter)}`,
  );
  for (const event of sync.rooms?.join?.[roomId]?.ephemeral?.events ?? []) {
    if (event.type !== 'm.receipt') continue;
    for (const [eventId, kinds] of Object.entries(
      event.content as Record<string, Record<string, Record<string, unknown>>>,
    )) {
      if (kinds['m.read']?.[userId]) return eventId;
    }
  }
  return null;
}

/**
 * Alice (registered, in no engine yet), bob, and the HTTP helpers both timeline contracts drive. Call
 * `waitForSynapseBackgroundUpdates` once before the first fixture.
 */
export async function timelineSynapseFixture(
  baseUrl: string,
  serverName: string,
  secret: string,
): Promise<
  Omit<TimelineContractSetup, 'engine' | 'alice' | 'dispose'> & {
    readonly alice: SynapseUser;
  }
> {
  const [alice, bob] = await register(baseUrl, secret);
  return {
    alice,
    bob: bob.userId,
    serverName,
    asAlice: {
      join: (roomId) => join(baseUrl, alice, roomId),
      fullyRead: async (roomId) => {
        try {
          const marker = await synapseRequest<{ event_id?: string }>(
            baseUrl,
            alice.accessToken,
            'GET',
            `/user/${encodeURIComponent(alice.userId)}${room(roomId)}/account_data/m.fully_read`,
          );
          return marker.event_id ?? null;
        } catch (error) {
          if (error instanceof Error && error.message.endsWith(' 404'))
            return null;
          throw error;
        }
      },
    },
    asBob: {
      createRoom: (name) => createRoom(baseUrl, bob, name),
      invite: (roomId, userId) => invite(baseUrl, bob, roomId, userId),
      send: (roomId, body) =>
        sendEvent(baseUrl, bob, roomId, 'm.room.message', text(body)),
      sendInThread: (roomId, rootId, body) =>
        sendEvent(baseUrl, bob, roomId, 'm.room.message', {
          ...text(body),
          'm.relates_to': {
            rel_type: 'm.thread',
            event_id: rootId,
            is_falling_back: true,
            'm.in_reply_to': { event_id: rootId },
          },
        }),
      react: async (roomId, eventId, key) => {
        await sendEvent(baseUrl, bob, roomId, 'm.reaction', {
          'm.relates_to': {
            rel_type: 'm.annotation',
            event_id: eventId,
            key,
          },
        });
      },
      redact: async (roomId, eventId) => {
        await synapseRequest(
          baseUrl,
          bob.accessToken,
          'PUT',
          `${room(roomId)}/redact/${encodeURIComponent(eventId)}/${localpart('txn')}`,
          {},
        );
      },
      edit: async (roomId, eventId, body) => {
        await sendEvent(
          baseUrl,
          bob,
          roomId,
          'm.room.message',
          edit(eventId, body),
        );
      },
      // The receipt reaches bob's sync asynchronously, so poll until it names an event.
      readReceipt: async (roomId, userId) => {
        const deadline = Date.now() + RECEIPT_TIMEOUT_MS;
        for (;;) {
          const eventId = await receiptIn(baseUrl, bob, roomId, userId);
          if (eventId || Date.now() > deadline) return eventId;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      },
      setPowerLevels: async (roomId, patch) => {
        const current = await powerLevels(baseUrl, bob, roomId);
        const { events, users, ...scalars } = patch;
        await synapseRequest(
          baseUrl,
          bob.accessToken,
          'PUT',
          `${room(roomId)}/state/m.room.power_levels/`,
          {
            ...current,
            ...scalars,
            ...(events && { events: { ...current.events, ...events } }),
            ...(users && { users: { ...current.users, ...users } }),
          },
        );
      },
      sendEvent: (roomId, type, content) =>
        sendEvent(baseUrl, bob, roomId, type, content),
      sendState: async (roomId, type, stateKey, content) => {
        const { event_id } = await synapseRequest<{ event_id: string }>(
          baseUrl,
          bob.accessToken,
          'PUT',
          `${room(roomId)}/state/${encodeURIComponent(type)}/${encodeURIComponent(stateKey)}`,
          content,
        );
        return event_id;
      },
      markRead: async (roomId, eventId) => {
        await synapseRequest(
          baseUrl,
          bob.accessToken,
          'POST',
          `${room(roomId)}/receipt/m.read/${encodeURIComponent(eventId)}`,
          {},
        );
      },
      // The v3 API has no relations endpoint, so read them off the room's recent history.
      relations: async (roomId, eventId, relType) => {
        const { chunk } = await synapseRequest<{
          chunk: {
            event_id: string;
            content?: {
              'm.relates_to'?: { rel_type?: string; event_id?: string };
            };
          }[];
        }>(
          baseUrl,
          bob.accessToken,
          'GET',
          `${room(roomId)}/messages?dir=b&limit=100`,
        );
        return chunk
          .filter(
            ({ content }) =>
              content?.['m.relates_to']?.rel_type === relType &&
              content['m.relates_to'].event_id === eventId,
          )
          .map((event) => event.event_id);
      },
    },
  };
}

/** As `resolvePortOffset` in e2e/support/homeserver/constants.mjs: the native stack's port shift. */
function portOffset(): number {
  const value = process.env['TRINITY_E2E_PORT_OFFSET'] ?? '';
  if (value === '') return 0;
  const offset = Number(value);
  if (!/^\d+$/.test(value) || offset % 100 !== 0 || offset >= 7000) {
    throw new Error(
      `Invalid TRINITY_E2E_PORT_OFFSET "${value}"; expected a multiple of 100 from 0 to 6900`,
    );
  }
  return offset;
}

// The harness's Open Graph page, as Synapse reaches it (see the link-preview journey):
// 127.0.0.1 natively, one shared loopback in a network container, else compose DNS.
const OG_PAGE =
  process.env['TRINITY_E2E_HOMESERVER_RUNTIME'] === 'native'
    ? `http://127.0.0.1:${8080 + portOffset()}/og`
    : process.env['TRINITY_E2E_NETWORK_CONTAINER']
      ? 'http://localhost:8080/og'
      : 'http://caddy:8080/og';

/** As `timelineSynapseFixture`, for the conversation content contract. */
export async function conversationContentSynapseFixture(
  baseUrl: string,
  _serverName: string,
  secret: string,
): Promise<
  Omit<ConversationContentContractSetup, 'engine' | 'alice' | 'dispose'> & {
    readonly alice: SynapseUser;
  }
> {
  const [alice, bob] = await register(baseUrl, secret);
  const send = (user: SynapseUser, roomId: string, content: unknown) =>
    sendEvent(baseUrl, user, roomId, 'm.room.message', content);
  return {
    alice,
    bob: bob.userId,
    previewableUrl: OG_PAGE,
    asAlice: {
      join: (roomId) => join(baseUrl, alice, roomId),
      send: (roomId, body) => send(alice, roomId, text(body)),
      edit: (roomId, eventId, body) => send(alice, roomId, edit(eventId, body)),
    },
    asBob: {
      createRoom: (name, options = {}) =>
        createRoom(baseUrl, bob, name, options.encrypted),
      invite: (roomId, userId) => invite(baseUrl, bob, roomId, userId),
      promote: async (roomId, userId) => {
        const levels = await powerLevels(baseUrl, bob, roomId);
        await synapseRequest(
          baseUrl,
          bob.accessToken,
          'PUT',
          `${room(roomId)}/state/m.room.power_levels/`,
          { ...levels, users: { ...levels.users, [userId]: 100 } },
        );
      },
      send: (roomId, body) => send(bob, roomId, text(body)),
      edit: (roomId, eventId, body) => send(bob, roomId, edit(eventId, body)),
      setPinned: async (roomId, eventIds) => {
        await synapseRequest(
          baseUrl,
          bob.accessToken,
          'PUT',
          `${room(roomId)}/state/m.room.pinned_events/`,
          { pinned: eventIds },
        );
      },
      pinnedList: async (roomId) =>
        (
          await synapseRequest<{ pinned?: unknown[] }>(
            baseUrl,
            bob.accessToken,
            'GET',
            `${room(roomId)}/state/m.room.pinned_events/`,
          )
        ).pinned ?? [],
    },
  };
}
