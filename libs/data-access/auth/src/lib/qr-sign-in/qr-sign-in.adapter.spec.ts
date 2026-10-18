import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OAuthGrantType, createClient } from 'matrix-js-sdk';
import { QrSignInAdapter } from './qr-sign-in.adapter';

vi.mock('matrix-js-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('matrix-js-sdk')>()),
  createClient: vi.fn(),
}));

function fakeClient(
  getAuthMetadata: () => Promise<{ grant_types_supported: string[] }>,
  feature = true,
) {
  const client = {
    getAuthMetadata: vi.fn(getAuthMetadata),
    doesServerSupportUnstableFeature: vi.fn(async () => feature),
    stopClient: vi.fn(),
  };
  vi.mocked(createClient).mockReturnValue(client as never);
  return client;
}

const deviceGrant = {
  grant_types_supported: [OAuthGrantType.DeviceAuthorization],
};

describe('QrSignInAdapter.isAvailable', () => {
  beforeEach(() => vi.mocked(createClient).mockReset());

  it('is true with the device grant and the MSC4108 feature', async () => {
    const client = fakeClient(async () => deviceGrant);
    expect(await new QrSignInAdapter().isAvailable('https://hs')).toBe(true);
    expect(createClient).toHaveBeenCalledWith({ baseUrl: 'https://hs' });
    expect(client.stopClient).toHaveBeenCalled();
  });

  it('is false without the device grant', async () => {
    fakeClient(async () => ({ grant_types_supported: [] }));
    expect(await new QrSignInAdapter().isAvailable('https://hs')).toBe(false);
  });

  it('is false without the MSC4108 feature', async () => {
    fakeClient(async () => deviceGrant, false);
    expect(await new QrSignInAdapter().isAvailable('https://hs')).toBe(false);
  });

  it('rejects when the auth metadata cannot be fetched, and still stops the client', async () => {
    const client = fakeClient(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(
      new QrSignInAdapter().isAvailable('https://hs'),
    ).rejects.toThrow('Failed to fetch');
    expect(client.stopClient).toHaveBeenCalled();
  });
});
