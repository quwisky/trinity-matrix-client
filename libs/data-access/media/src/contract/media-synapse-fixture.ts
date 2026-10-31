import { registerSynapseUser, synapseRequest } from '@trinity/testing';
import { IMAGE_PACK_EVENT_TYPE } from '../lib/image-pack.model';
import type { ExpressionContractSetup } from './expression-engine.contract';
import type { ContractMessage } from './media-engine.contract';

type SynapseUser = Awaited<ReturnType<typeof registerSynapseUser>>;

export interface MediaSynapseFixture {
  readonly alice: SynapseUser;
  stored(
    mxc: string,
  ): Promise<{ readonly filename: string | null; readonly mimeType: string }>;
  /** Creates the room over HTTP. The spec waits until its engine sees it. */
  createRoom(encrypted: boolean): Promise<string>;
  messages(roomId: string): Promise<readonly ContractMessage[]>;
}

export interface ExpressionSynapseFixture {
  readonly alice: SynapseUser;
  createOwnRoom(): Promise<string>;
  leave(roomId: string): Promise<void>;
  foreignPackRoom: ExpressionContractSetup['foreignPackRoom'];
}

const room = (roomId: string) => `/rooms/${encodeURIComponent(roomId)}`;

let sequence = 0;

function localpart(role: string): string {
  sequence += 1;
  return `md-${role}-${Date.now().toString(36)}-${sequence}-${Math.random().toString(36).slice(2, 6)}`;
}

function filenameOf(disposition: string): string | null {
  const encoded = /filename\*=utf-8''([^;]+)/i.exec(disposition)?.[1];
  if (encoded) return decodeURIComponent(encoded);
  return /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? null;
}

/** Alice (registered with a device, signed in to no engine yet) and the HTTP helpers the media contract drives. */
export async function mediaSynapseFixture(
  baseUrl: string,
  secret: string,
): Promise<MediaSynapseFixture> {
  const alice = await registerSynapseUser(baseUrl, secret, localpart('alice'));
  return {
    alice,
    stored: async (mxc) => {
      const res = await fetch(
        `${baseUrl}/_matrix/client/v1/media/download/${mxc.slice('mxc://'.length)}`,
        { headers: { authorization: `Bearer ${alice.accessToken}` } },
      );
      if (!res.ok) throw new Error(`Synapse download failed: ${res.status}`);
      return {
        filename: filenameOf(res.headers.get('content-disposition') ?? ''),
        mimeType: (res.headers.get('content-type') ?? '').split(';')[0].trim(),
      };
    },
    createRoom: async (encrypted) =>
      (
        await synapseRequest<{ room_id: string }>(
          baseUrl,
          alice.accessToken,
          'POST',
          '/createRoom',
          {
            preset: 'private_chat',
            ...(encrypted
              ? {
                  initial_state: [
                    {
                      type: 'm.room.encryption',
                      state_key: '',
                      content: { algorithm: 'm.megolm.v1.aes-sha2' },
                    },
                  ],
                }
              : {}),
          },
        )
      ).room_id,
    messages: async (roomId) => {
      const { chunk } = await synapseRequest<{
        chunk: { type: string; content: Record<string, unknown> }[];
      }>(
        baseUrl,
        alice.accessToken,
        'GET',
        `${room(roomId)}/messages?dir=f&limit=100`,
      );
      return chunk
        .filter(
          (event) =>
            event.type === 'm.room.message' &&
            typeof event.content['msgtype'] === 'string',
        )
        .map(({ content }) => {
          const info = content['info'] as Record<string, unknown> | undefined;
          return {
            msgtype: String(content['msgtype']),
            body: String(content['body']),
            hasThumbnail: Boolean(
              info?.['thumbnail_url'] ?? info?.['thumbnail_file'],
            ),
          };
        });
    },
  };
}

/** Alice and bob, and the HTTP helpers the expression contract drives. */
export async function expressionSynapseFixture(
  baseUrl: string,
  secret: string,
): Promise<ExpressionSynapseFixture> {
  const alice = await registerSynapseUser(baseUrl, secret, localpart('alice'));
  const bob = await registerSynapseUser(baseUrl, secret, localpart('bob'));
  const server = bob.userId.slice(bob.userId.indexOf(':') + 1);
  return {
    alice,
    createOwnRoom: async () =>
      (
        await synapseRequest<{ room_id: string }>(
          baseUrl,
          alice.accessToken,
          'POST',
          '/createRoom',
          { preset: 'private_chat', room_version: '11' },
        )
      ).room_id,
    leave: async (roomId) => {
      await synapseRequest(
        baseUrl,
        alice.accessToken,
        'POST',
        `${room(roomId)}/leave`,
        {},
      );
    },
    foreignPackRoom: async (name, pack) => {
      const aliasLocal = localpart('pack');
      const { room_id } = await synapseRequest<{ room_id: string }>(
        baseUrl,
        bob.accessToken,
        'POST',
        '/createRoom',
        {
          preset: 'public_chat',
          name,
          room_alias_name: aliasLocal,
          initial_state: [
            { type: IMAGE_PACK_EVENT_TYPE, state_key: '', content: pack },
            {
              type: 'm.room.history_visibility',
              state_key: '',
              content: { history_visibility: 'world_readable' },
            },
          ],
        },
      );
      return { roomId: room_id, alias: `#${aliasLocal}:${server}` };
    },
  };
}
