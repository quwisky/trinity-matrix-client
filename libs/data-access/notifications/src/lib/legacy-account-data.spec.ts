import { describe, expect, it, vi } from 'vitest';
import {
  copyLegacyAccountData,
  migratedAccountDataContent,
} from './legacy-account-data';

const NEW = 'dev.trinityproject.trinity.x';
const OLD = 'eu.qwky.trinity.x';

function client(
  stored: Record<string, unknown>,
  write = vi.fn(() => Promise.resolve({})),
) {
  return {
    getAccountData: vi.fn((type: string) =>
      type in stored ? { getContent: () => stored[type] } : undefined,
    ),
    setAccountData: write,
  };
}

describe('migratedAccountDataContent', () => {
  it('reads the new name when present, even if the old one differs', () => {
    expect(
      migratedAccountDataContent(
        client({ [NEW]: { v: 'new' }, [OLD]: { v: 'old' } }) as never,
        NEW,
        OLD,
      ),
    ).toEqual({ v: 'new' });
  });
  it('falls back to the old name while only it exists', () => {
    expect(
      migratedAccountDataContent(
        client({ [OLD]: { v: 'old' } }) as never,
        NEW,
        OLD,
      ),
    ).toEqual({ v: 'old' });
  });
  it('returns undefined when neither exists or there is no client', () => {
    expect(
      migratedAccountDataContent(client({}) as never, NEW, OLD),
    ).toBeUndefined();
    expect(migratedAccountDataContent(null, NEW, OLD)).toBeUndefined();
  });
});

describe('copyLegacyAccountData', () => {
  it('copies the old value to the new name once', () => {
    const c = client({ [OLD]: { v: 'old' } });
    copyLegacyAccountData(c as never, NEW, OLD);
    copyLegacyAccountData(c as never, NEW, OLD); // still in flight: no second write
    expect(c.setAccountData).toHaveBeenCalledTimes(1);
    expect(c.setAccountData).toHaveBeenCalledWith(NEW, { v: 'old' });
  });
  it('writes nothing when the new name exists or the old one does not', () => {
    const both = client({ [NEW]: { v: 'new' }, [OLD]: { v: 'old' } });
    const none = client({});
    copyLegacyAccountData(both as never, NEW, OLD);
    copyLegacyAccountData(none as never, NEW, OLD);
    expect(both.setAccountData).not.toHaveBeenCalled();
    expect(none.setAccountData).not.toHaveBeenCalled();
  });
  it('swallows a failed write and tries again on the next call', async () => {
    const write = vi.fn(() => Promise.reject(new Error('offline')));
    const c = client({ [OLD]: { v: 'old' } }, write);
    copyLegacyAccountData(c as never, NEW, OLD);
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0)); // let finally() clear the in-flight mark
    copyLegacyAccountData(c as never, NEW, OLD);
    expect(write).toHaveBeenCalledTimes(2);
  });
});
