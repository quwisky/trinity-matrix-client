import { EngineRequestError } from '@trinity/util/matrix';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { FakeExpressionEngine } from '../contract/fake-expression-engine';
import {
  AccountPackTarget,
  RoomPackTarget,
  packEntries,
} from './image-pack-target';

const content = {
  pack: { display_name: 'Mine' },
  images: { wave: { url: 'mxc://hs/wave', body: 'Wave' } },
};

function accountSetup(data: Record<string, Record<string, unknown>> = {}) {
  const engine = new FakeExpressionEngine();
  const alice = engine.alice;
  for (const [type, value] of Object.entries(data)) {
    engine.setAccountData(alice, type, value).subscribe();
  }
  return {
    engine,
    alice,
    write: vi.spyOn(engine, 'setAccountData'),
    fetch: vi.spyOn(engine, 'fetchAccountData'),
  };
}

describe('AccountPackTarget', () => {
  const target = new AccountPackTarget();

  async function read(engine: FakeExpressionEngine) {
    return target.read(
      await firstValueFrom(target.snapshot(engine, engine.alice)),
    );
  }

  it('reads m.image_pack', async () => {
    const { engine } = accountSetup({ 'm.image_pack': content });
    expect(await read(engine)).toEqual(content);
  });

  it('falls back to im.ponies.user_emotes when m.image_pack is absent', async () => {
    const { engine } = accountSetup({ 'im.ponies.user_emotes': content });
    expect(await read(engine)).toEqual(content);
  });

  it('write puts m.image_pack only', async () => {
    const { engine, alice, write } = accountSetup();
    await target.write(engine, alice, content);
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(alice, 'm.image_pack', content);
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
    const { engine, alice, write } = accountSetup({ 'm.image_pack': stored });
    const current = await read(engine);
    await target.write(engine, alice, {
      ...current,
      images: { ...current.images, added: { url: 'mxc://hs/added' } },
    });
    const written = write.mock.calls[0][2] as typeof stored;
    expect(written.images['junk']).toEqual({ url: 42, future: true });
    expect(written.pack).toEqual(stored.pack);
    expect(Object.keys(written.images)).toEqual(['ok', 'junk', 'added']);
  });

  it('the snapshot follows either account-data type', () => {
    const { engine, alice } = accountSetup();
    const seen: string[][] = [];
    const subscription = target
      .snapshot(engine, alice)
      .subscribe((snapshot) =>
        seen.push(Object.keys(target.read(snapshot).images)),
      );
    engine
      .setAccountData(alice, 'im.ponies.user_emotes', {
        images: { old: {} },
      })
      .subscribe();
    engine
      .setAccountData(alice, 'm.image_pack', { images: { new: {} } })
      .subscribe();
    engine.setAccountData(alice, 'm.other', { images: {} }).subscribe();
    subscription.unsubscribe();
    expect(seen).toEqual([[], ['old'], ['new']]);
  });

  it('may always write its own account data', () => {
    expect(target.canWrite()).toBe(true);
  });
});

describe('AccountPackTarget.readServer', () => {
  const target = new AccountPackTarget();

  it('reads m.image_pack, then im.ponies.user_emotes, then nothing', async () => {
    const { engine, alice, fetch } = accountSetup({
      'im.ponies.user_emotes': content,
    });
    expect(await target.readServer(engine, alice)).toEqual(content);
    expect(fetch.mock.calls).toEqual([
      [alice, 'm.image_pack'],
      [alice, 'im.ponies.user_emotes'],
    ]);
    expect(await target.readServer(accountSetup().engine, alice)).toEqual({
      pack: {},
      images: {},
    });
  });

  it('rejects with the engine failure for an account without a client', async () => {
    const { engine } = accountSetup();
    await expect(target.readServer(engine, '@gone:hs')).rejects.toBeInstanceOf(
      EngineRequestError,
    );
    await expect(
      target.write(engine, '@gone:hs', content),
    ).rejects.toMatchObject({ failure: { code: 'account-not-live' } });
  });

  it('names the pack Your emoji', () => {
    expect(target.defaultName()).toBe('Your emoji');
  });
});

describe('RoomPackTarget', () => {
  const legacy = {
    pack: { display_name: 'Old' },
    images: { old: { url: 'mxc://hs/old' } },
  };

  function room(
    state: Record<string, unknown> = {},
    {
      writable = true,
      joined = true,
      name = 'Party room' as string | undefined,
    } = {},
  ) {
    const engine = new FakeExpressionEngine();
    const roomId = engine.addRoom({
      name,
      writable,
      joined,
      state: Object.entries(state).map(([type, value]) => ({
        type,
        state_key: '',
        content: value,
      })),
    });
    const target = new RoomPackTarget(roomId);
    const snapshot = () =>
      firstValueFrom(target.snapshot(engine, engine.alice));
    return {
      engine,
      alice: engine.alice,
      roomId,
      target,
      snapshot,
      read: async () => target.read(await snapshot()),
      write: vi.spyOn(engine, 'setRoomState'),
      fetch: vi.spyOn(engine, 'fetchRoomState'),
    };
  }

  it('prefers m.room.image_pack over the legacy pack', async () => {
    const { read } = room({
      'm.room.image_pack': content,
      'im.ponies.room_emotes': legacy,
    });
    expect(await read()).toEqual(content);
  });

  it('falls back to im.ponies.room_emotes', async () => {
    const { read } = room({ 'im.ponies.room_emotes': legacy });
    expect(await read()).toEqual(legacy);
  });

  it('reads an unknown room as empty', async () => {
    const { engine } = room({ 'm.room.image_pack': content });
    const other = new RoomPackTarget('!other:hs');
    expect(
      other.read(await firstValueFrom(other.snapshot(engine, engine.alice))),
    ).toEqual({ pack: {}, images: {} });
  });

  it('writes only m.room.image_pack under the empty state key', async () => {
    const { target, engine, alice, roomId, write } = room({
      'im.ponies.room_emotes': legacy,
    });
    await target.write(engine, alice, content);
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(
      alice,
      roomId,
      'm.room.image_pack',
      '',
      content,
    );
  });

  it('readServer reads the stable pack, then the legacy one, then nothing', async () => {
    const { target, engine, alice, roomId, fetch } = room({
      'im.ponies.room_emotes': legacy,
    });
    expect(await target.readServer(engine, alice)).toEqual(legacy);
    expect(fetch.mock.calls).toEqual([
      [alice, roomId, 'm.room.image_pack', ''],
      [alice, roomId, 'im.ponies.room_emotes', ''],
    ]);
    const empty = room();
    expect(await empty.target.readServer(empty.engine, alice)).toEqual({
      pack: {},
      images: {},
    });
  });

  it('readServer rejects with other failures', async () => {
    const { target, engine, alice } = room({}, { joined: false });
    await expect(target.readServer(engine, alice)).rejects.toMatchObject({
      failure: { kind: 'permission' },
    });
  });

  it('the snapshot follows only this room’s own pack', async () => {
    const { target, engine, alice, roomId } = room({
      'm.room.image_pack': content,
    });
    const seen: string[][] = [];
    const subscription = target
      .snapshot(engine, alice)
      .subscribe((snapshot) =>
        seen.push(Object.keys(target.read(snapshot).images)),
      );
    const set = (key: string, images: Record<string, unknown>) =>
      engine
        .setRoomState(alice, roomId, 'm.room.image_pack', key, { images })
        .subscribe();
    set('other-pack', { other: {} });
    set('', { mine: {} });
    subscription.unsubscribe();
    set('', {});
    expect(seen.at(0)).toEqual(['wave']);
    expect(seen.at(-1)).toEqual(['mine']);
    expect(seen.flat()).not.toContain('other');
  });

  it('canWrite follows the power to send m.room.image_pack', async () => {
    const allowed = room();
    expect(allowed.target.canWrite(await allowed.snapshot())).toBe(true);
    const denied = room({}, { writable: false });
    expect(denied.target.canWrite(await denied.snapshot())).toBe(false);
    const other = new RoomPackTarget('!other:hs');
    expect(
      other.canWrite(
        await firstValueFrom(other.snapshot(allowed.engine, allowed.alice)),
      ),
    ).toBe(false);
  });

  it('is named after the room, or Room emoji without a name', async () => {
    const named = room();
    expect(named.target.defaultName(await named.snapshot())).toBe('Party room');
    const blank = room({}, { name: ' ' });
    expect(blank.target.defaultName(await blank.snapshot())).toBe('Room emoji');
  });
});
