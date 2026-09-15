import { beforeEach, describe, expect, it, vi } from 'vitest';

const { evaluateNative, waitForNativeShellState } = vi.hoisted(() => ({
  evaluateNative: vi.fn(),
  waitForNativeShellState: vi.fn(async (read, accepts) => {
    const value = await read();
    if (!accepts(value)) throw new Error('mock bounded observation timeout');
    return value;
  }),
}));

vi.mock('../e2e/android/native-shell-client.mts', () => ({
  evaluateNative,
  waitForNativeShellState,
}));

const { assertMemberPresence } =
  await import('../e2e/android/identity-presence-observer.mts');

const observation = (name, presence) => ({
  name,
  visible: true,
  avatarCount: 1,
  avatarVisible: true,
  imageCount: 0,
  images: [],
  presence,
});

const online = {
  visible: true,
  role: 'img',
  ariaLabel: 'Online',
  dataPresence: 'online',
};

const client = () => ({
  signal: new AbortController().signal,
  webview: {},
  record: vi.fn(async () => undefined),
});

function queueMemberObservations(rows) {
  evaluateNative
    .mockResolvedValueOnce(rows)
    .mockResolvedValueOnce(rows)
    .mockResolvedValueOnce(rows)
    .mockResolvedValueOnce(rows)
    .mockResolvedValueOnce([rows[1]]);
}

describe('identity presence observer', () => {
  beforeEach(() => {
    evaluateNative.mockReset();
    waitForNativeShellState.mockClear();
  });

  it('uses the first existing dot when the first seeded row has unknown presence', async () => {
    const reader = observation('reader', online);
    const rows = [observation('member', null), reader];
    queueMemberObservations(rows);
    const testClient = client();

    await expect(
      assertMemberPresence(testClient, 'reader', 'member'),
    ).resolves.toBeUndefined();

    expect(testClient.record).toHaveBeenCalledWith(
      'members.first-dot-role',
      expect.objectContaining({
        observation: expect.arrayContaining([
          expect.objectContaining({ name: 'reader', presence: online }),
        ]),
      }),
    );
    expect(testClient.record).toHaveBeenCalledWith(
      'members.first-dot-label',
      expect.objectContaining({
        observation: expect.arrayContaining([
          expect.objectContaining({ name: 'reader', presence: online }),
        ]),
      }),
    );
  });

  it('rejects an invalid first existing dot even when a later dot is valid', async () => {
    const invalid = {
      visible: true,
      role: 'status',
      ariaLabel: 'Unknown',
      dataPresence: 'online',
    };
    const rows = [
      observation('member', invalid),
      observation('reader', online),
    ];
    queueMemberObservations(rows);
    const testClient = client();

    await expect(
      assertMemberPresence(testClient, 'reader', 'member'),
    ).rejects.toThrow('mock bounded observation timeout');
    expect(testClient.record).toHaveBeenCalledWith(
      'members.first-dot-role-failure',
      expect.objectContaining({ assertion: 'members.first-dot-role' }),
    );
  });
});
