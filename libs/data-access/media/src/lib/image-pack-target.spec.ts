import {
  ClientEvent,
  MatrixError,
  RoomStateEvent,
  type MatrixClient,
} from 'matrix-js-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  AccountPackTarget,
  RoomPackTarget,
  packEntries,
} from './image-pack-target';

const content = {
  pack: { display_name: 'Mine' },
  images: { wave: { url: 'mxc://hs/wave', body: 'Wave' } },
};

function fake(data: Record<string, unknown> = {}) {
  const listeners = new Set<(e: unknown) => void>();
  const client = {
    getUserId: () => '@me:hs',
    http: { authedRequest: vi.fn() },
    getAccountData: (type: string) =>
      type in data ? { getContent: () => data[type] } : undefined,
    setAccountDataRaw: vi.fn().mockResolvedValue({}),
    on: vi.fn((_: string, l: (e: unknown) => void) => listeners.add(l)),
    off: vi.fn((_: string, l: (e: unknown) => void) => listeners.delete(l)),
  };
  return {
    client: client as unknown as MatrixClient,
    raw: client,
    emit: (type: string) =>
      listeners.forEach((l) => l({ getType: () => type })),
  };
}

describe('AccountPackTarget', () => {
  const target = new AccountPackTarget();

  it('reads m.image_pack', () => {
    const { client } = fake({ 'm.image_pack': content });
    expect(target.read(client)).toEqual(content);
  });

  it('falls back to im.ponies.user_emotes when m.image_pack is absent', () => {
    const { client } = fake({ 'im.ponies.user_emotes': content });
    expect(target.read(client)).toEqual(content);
  });

  it('write puts m.image_pack only', async () => {
    const { client, raw } = fake();
    await target.write(client, content);
    expect(raw.setAccountDataRaw).toHaveBeenCalledOnce();
    expect(raw.setAccountDataRaw).toHaveBeenCalledWith('m.image_pack', content);
  });

  it('packEntries skips invalid entries', () => {
    const entries = packEntries({
      pack: {},
      images: {
        ok: { url: 'mxc://hs/ok', usage: ['sticker'], info: { w: 1 } },
        badUrl: { url: 'https://x/y' },
        notObject: 'nope',
        badUsage: { url: 'mxc://hs/u', usage: ['other'] },
      },
    });
    expect(entries).toEqual([
      {
        shortcode: 'ok',
        url: 'mxc://hs/ok',
        info: { w: 1 },
        usage: ['sticker'],
      },
    ]);
  });

  it('an invalid entry survives a read-modify-write', async () => {
    const stored = {
      pack: { display_name: 'Mine', extra: 1 },
      images: { ok: { url: 'mxc://hs/ok' }, junk: { url: 42, future: true } },
    };
    const { client, raw } = fake({ 'm.image_pack': stored });
    const read = target.read(client);
    await target.write(client, {
      ...read,
      images: { ...read.images, added: { url: 'mxc://hs/added' } },
    });
    const written = raw.setAccountDataRaw.mock.calls[0][1] as typeof stored;
    expect(written.images['junk']).toEqual({ url: 42, future: true });
    expect(written.pack).toEqual(stored.pack);
    expect(Object.keys(written.images)).toEqual(['ok', 'junk', 'added']);
  });

  it('watch fires on either account-data type and stops on cleanup', () => {
    const { client, raw, emit } = fake();
    const onChange = vi.fn();
    const stop = target.watch(client, onChange);
    expect(raw.on).toHaveBeenCalledWith(
      ClientEvent.AccountData,
      expect.any(Function),
    );
    emit('m.image_pack');
    emit('im.ponies.user_emotes');
    emit('m.other');
    expect(onChange).toHaveBeenCalledTimes(2);
    stop();
    emit('m.image_pack');
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

describe('AccountPackTarget.readServer', () => {
  const target = new AccountPackTarget();
  const notFound = () => new MatrixError({ errcode: 'M_NOT_FOUND' }, 404);

  it('reads m.image_pack, then im.ponies.user_emotes, then nothing', async () => {
    const { client, raw } = fake();
    raw.http.authedRequest
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce(content);
    expect(await target.readServer(client)).toEqual(content);
    expect(raw.http.authedRequest.mock.calls.map((call) => call[1])).toEqual([
      '/user/%40me%3Ahs/account_data/m.image_pack',
      '/user/%40me%3Ahs/account_data/im.ponies.user_emotes',
    ]);
    raw.http.authedRequest.mockRejectedValue(notFound());
    expect(await target.readServer(client)).toEqual({ pack: {}, images: {} });
  });

  it('names the pack Your emoji', () => {
    expect(target.defaultName(fake().client)).toBe('Your emoji');
  });
});

describe('RoomPackTarget', () => {
  const roomId = '!room:hs';
  const target = new RoomPackTarget(roomId);
  const legacy = {
    pack: { display_name: 'Old' },
    images: { old: { url: 'mxc://hs/old' } },
  };

  function room(
    state: Record<string, unknown> = {},
    { mayEdit = true, name = 'Party room' } = {},
  ) {
    const listeners = new Set<(e: unknown) => void>();
    const roomState = {
      getStateEvents: (type: string, key: string) =>
        key === '' && type in state ? { getContent: () => state[type] } : null,
      maySendStateEvent: vi.fn(() => mayEdit),
    };
    const raw = {
      getUserId: () => '@me:hs',
      getRoom: (id: string) =>
        id === roomId
          ? {
              roomId,
              name,
              getLiveTimeline: () => ({ getState: () => roomState }),
            }
          : null,
      sendStateEvent: vi.fn().mockResolvedValue({ event_id: '$e' }),
      getStateEvent: vi.fn(),
      on: vi.fn((_: string, l: (e: unknown) => void) => listeners.add(l)),
      off: vi.fn((_: string, l: (e: unknown) => void) => listeners.delete(l)),
    };
    return {
      client: raw as unknown as MatrixClient,
      raw,
      roomState,
      emit: (type: string, inRoom = roomId, stateKey = '') =>
        listeners.forEach((l) =>
          l({
            getType: () => type,
            getRoomId: () => inRoom,
            getStateKey: () => stateKey,
          }),
        ),
    };
  }

  it('prefers m.room.image_pack over the legacy pack', () => {
    const { client } = room({
      'm.room.image_pack': content,
      'im.ponies.room_emotes': legacy,
    });
    expect(target.read(client)).toEqual(content);
  });

  it('falls back to im.ponies.room_emotes', () => {
    const { client } = room({ 'im.ponies.room_emotes': legacy });
    expect(target.read(client)).toEqual(legacy);
  });

  it('reads an unknown room as empty', () => {
    const { client } = room();
    expect(new RoomPackTarget('!other:hs').read(client)).toEqual({
      pack: {},
      images: {},
    });
  });

  it('writes only m.room.image_pack under the empty state key', async () => {
    const { client, raw } = room({ 'im.ponies.room_emotes': legacy });
    await target.write(client, content);
    expect(raw.sendStateEvent).toHaveBeenCalledOnce();
    expect(raw.sendStateEvent).toHaveBeenCalledWith(
      roomId,
      'm.room.image_pack',
      content,
      '',
    );
  });

  it('readServer reads the stable pack, then the legacy one, then nothing', async () => {
    const { client, raw } = room();
    const notFound = new MatrixError({ errcode: 'M_NOT_FOUND' }, 404);
    raw.getStateEvent
      .mockRejectedValueOnce(notFound)
      .mockResolvedValueOnce(legacy);
    expect(await target.readServer(client)).toEqual(legacy);
    expect(raw.getStateEvent.mock.calls).toEqual([
      [roomId, 'm.room.image_pack', ''],
      [roomId, 'im.ponies.room_emotes', ''],
    ]);
    raw.getStateEvent.mockRejectedValue(notFound);
    expect(await target.readServer(client)).toEqual({ pack: {}, images: {} });
  });

  it('readServer rethrows other errors', async () => {
    const { client, raw } = room();
    raw.getStateEvent.mockRejectedValue(
      new MatrixError({ errcode: 'M_FORBIDDEN' }, 403),
    );
    await expect(target.readServer(client)).rejects.toMatchObject({
      errcode: 'M_FORBIDDEN',
    });
  });

  it('watch fires only for this room’s own pack and stops on cleanup', () => {
    const { client, raw, emit } = room();
    const onChange = vi.fn();
    const stop = target.watch(client, onChange);
    expect(raw.on).toHaveBeenCalledWith(
      RoomStateEvent.Events,
      expect.any(Function),
    );
    emit('m.room.image_pack');
    emit('im.ponies.room_emotes');
    emit('m.room.image_pack', '!other:hs');
    emit('m.room.image_pack', roomId, 'other-pack');
    emit('m.room.name');
    expect(onChange).toHaveBeenCalledTimes(2);
    stop();
    emit('m.room.image_pack');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('canWrite follows the power to send m.room.image_pack', () => {
    const allowed = room();
    expect(target.canWrite(allowed.client)).toBe(true);
    expect(allowed.roomState.maySendStateEvent).toHaveBeenCalledWith(
      'm.room.image_pack',
      '@me:hs',
    );
    expect(target.canWrite(room({}, { mayEdit: false }).client)).toBe(false);
    expect(new RoomPackTarget('!other:hs').canWrite(allowed.client)).toBe(
      false,
    );
  });

  it('is named after the room, or Room emoji without a name', () => {
    expect(target.defaultName(room().client)).toBe('Party room');
    expect(target.defaultName(room({}, { name: ' ' }).client)).toBe(
      'Room emoji',
    );
  });
});
