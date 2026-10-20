import { ClientEvent, type MatrixClient } from 'matrix-js-sdk';
import { describe, expect, it, vi } from 'vitest';
import { AccountPackTarget, packEntries } from './image-pack-target';

const content = {
  pack: { display_name: 'Mine' },
  images: { wave: { url: 'mxc://hs/wave', body: 'Wave' } },
};

function fake(data: Record<string, unknown> = {}) {
  const listeners = new Set<(e: unknown) => void>();
  const client = {
    getUserId: () => '@me:hs',
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
