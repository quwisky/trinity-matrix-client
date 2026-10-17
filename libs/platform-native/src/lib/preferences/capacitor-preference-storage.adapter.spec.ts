import { Preferences } from '@capacitor/preferences';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { CapacitorPreferenceStorageAdapter } from './capacitor-preference-storage.adapter';

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(), set: vi.fn(), remove: vi.fn(), keys: vi.fn() },
}));

const get = Preferences.get as unknown as Mock;
const set = Preferences.set as unknown as Mock;
const remove = Preferences.remove as unknown as Mock;
const keys = Preferences.keys as unknown as Mock;

describe('CapacitorPreferenceStorageAdapter', () => {
  beforeEach(() => {
    get.mockReset().mockResolvedValue({ value: null });
    set.mockReset().mockResolvedValue(undefined);
    remove.mockReset().mockResolvedValue(undefined);
    keys.mockReset().mockResolvedValue({ keys: [] });
  });

  it("removes one account's value under its scoped key", async () => {
    const adapter = new CapacitorPreferenceStorageAdapter();

    await expect(
      firstValueFrom(
        adapter.remove({
          key: 'trinity.example',
          context: { kind: 'account', accountId: '@alice:example.org' },
          sensitivity: 'private',
          storage: 'device-preferences',
        }),
      ),
    ).resolves.toEqual({ kind: 'completed' });
    expect(remove).toHaveBeenCalledWith({
      key: 'trinity.example.account.%40alice%3Aexample.org',
    });
  });

  it("removes every conversation value of one account and no one else's", async () => {
    keys.mockResolvedValue({
      keys: [
        'trinity.example.conversation.%40alice%3Aexample%2Eorg.!a%3Aexample%2Eorg',
        'trinity.example.conversation.%40alice%3Aexample%2Eorg.!b%3Aexample%2Eorg',
        'trinity.example.conversation.%40alicia%3Aexample%2Eorg.!a%3Aexample%2Eorg',
        'trinity.example.account.%40alice%3Aexample.org',
        'trinity.other.conversation.%40alice%3Aexample%2Eorg.!a%3Aexample%2Eorg',
      ],
    });
    const adapter = new CapacitorPreferenceStorageAdapter();

    await firstValueFrom(
      adapter.remove({
        key: 'trinity.example',
        context: {
          kind: 'every-conversation',
          accountId: '@alice:example.org',
        },
        sensitivity: 'private',
        storage: 'device-preferences',
      }),
    );

    expect(remove.mock.calls.map(([{ key }]) => key)).toEqual([
      'trinity.example.conversation.%40alice%3Aexample%2Eorg.!a%3Aexample%2Eorg',
      'trinity.example.conversation.%40alice%3Aexample%2Eorg.!b%3Aexample%2Eorg',
    ]);
  });

  it("never removes another account whose server name starts with this one's", async () => {
    const adapter = new CapacitorPreferenceStorageAdapter();
    const write = (accountId: string) =>
      firstValueFrom(
        adapter.write({
          key: 'trinity.example',
          context: {
            kind: 'conversation',
            accountId,
            conversationId: '!a:example.org',
          },
          sensitivity: 'private',
          storage: 'device-preferences',
          payload: 'x',
        }),
      );
    await write('@alice:example.org');
    await write('@alice:example.org.uk');
    const [own, other] = set.mock.calls.map(([{ key }]) => key as string);
    keys.mockResolvedValue({ keys: [own, other] });

    await firstValueFrom(
      adapter.remove({
        key: 'trinity.example',
        context: {
          kind: 'every-conversation',
          accountId: '@alice:example.org',
        },
        sensitivity: 'private',
        storage: 'device-preferences',
      }),
    );

    expect(remove.mock.calls.map(([{ key }]) => key)).toEqual([own]);
  });

  it('turns a removal failure into a stable unavailable outcome', async () => {
    remove.mockRejectedValue(new Error('disk full'));
    const adapter = new CapacitorPreferenceStorageAdapter();

    await expect(
      firstValueFrom(
        adapter.remove({
          key: 'trinity.example',
          context: { kind: 'account', accountId: '@alice:example.org' },
          sensitivity: 'private',
          storage: 'device-preferences',
        }),
      ),
    ).resolves.toEqual({
      kind: 'unavailable',
      diagnostic: { code: 'device-preferences-remove-failed' },
    });
  });

  it('keeps account and conversation keys physically distinct', async () => {
    const adapter = new CapacitorPreferenceStorageAdapter();

    await firstValueFrom(
      adapter.write({
        key: 'trinity.example',
        context: { kind: 'account', accountId: '@alice:example.org' },
        sensitivity: 'private',
        storage: 'device-preferences',
        payload: 'account',
      }),
    );
    await firstValueFrom(
      adapter.write({
        key: 'trinity.example',
        context: {
          kind: 'conversation',
          accountId: '@alice:example.org',
          conversationId: '!room:example.org',
        },
        sensitivity: 'private',
        storage: 'device-preferences',
        payload: 'conversation',
      }),
    );

    expect(set.mock.calls[0][0].key).not.toBe(set.mock.calls[1][0].key);
    expect(set.mock.calls[0][0].key).toContain('.account.');
    expect(set.mock.calls[1][0].key).toContain('.conversation.');
  });

  it('refuses secret values before they reach device Preferences', async () => {
    const adapter = new CapacitorPreferenceStorageAdapter();

    const outcome = await firstValueFrom(
      adapter.write({
        key: 'secret',
        context: { kind: 'installation' },
        sensitivity: 'secret',
        storage: 'secure-store',
        payload: 'access_token=must-not-leak',
      }),
    );

    expect(outcome).toEqual({
      kind: 'unavailable',
      diagnostic: { code: 'secret-preference-requires-secure-store' },
    });
    expect(JSON.stringify(outcome)).not.toContain('access_token');
    expect(set).not.toHaveBeenCalled();
  });

  it('keeps server-authoritative preferences out of the device adapter', async () => {
    const adapter = new CapacitorPreferenceStorageAdapter();

    const outcome = await firstValueFrom(
      adapter.read({
        key: 'server.preference',
        context: {
          kind: 'server-authoritative',
          accountId: '@alice:example.org',
        },
        sensitivity: 'private',
        storage: 'server-authoritative',
      }),
    );

    expect(outcome).toEqual({
      kind: 'unavailable',
      diagnostic: { code: 'preference-storage-policy-unavailable' },
    });
    expect(get).not.toHaveBeenCalled();
  });

  it('turns storage rejection into a stable unavailable outcome', async () => {
    get.mockRejectedValue(
      new Error('hostile stored value access_token=secret'),
    );
    const adapter = new CapacitorPreferenceStorageAdapter();

    const outcome = await firstValueFrom(
      adapter.read({
        key: 'trinity.example',
        context: { kind: 'installation' },
        sensitivity: 'public',
        storage: 'device-preferences',
      }),
    );

    expect(outcome).toEqual({
      kind: 'unavailable',
      diagnostic: { code: 'device-preferences-read-failed' },
    });
    expect(JSON.stringify(outcome)).not.toContain('access_token');
  });
});
