import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HTTPError,
  MatrixError,
  OAuthGrantType,
  createClient,
} from 'matrix-js-sdk';
import { QrSignInAdapter } from './qr-sign-in.adapter';
import { QR_SIGN_IN_COMPLETION } from './qr-sign-in-completion.port';

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

function adapter(): QrSignInAdapter {
  TestBed.configureTestingModule({
    providers: [{ provide: QR_SIGN_IN_COMPLETION, useValue: {} }],
  });
  return TestBed.inject(QrSignInAdapter);
}

const deviceGrant = {
  grant_types_supported: [OAuthGrantType.DeviceAuthorization],
};

describe('QrSignInAdapter.isAvailable', () => {
  beforeEach(() => vi.mocked(createClient).mockReset());

  it('is true with the device grant and the MSC4108 feature', async () => {
    const client = fakeClient(async () => deviceGrant);
    expect(await adapter().isAvailable('https://hs')).toBe(true);
    expect(createClient).toHaveBeenCalledWith({ baseUrl: 'https://hs' });
    expect(client.stopClient).toHaveBeenCalled();
  });

  it('is false without the device grant', async () => {
    fakeClient(async () => ({ grant_types_supported: [] }));
    expect(await adapter().isAvailable('https://hs')).toBe(false);
  });

  it('is false without the MSC4108 feature', async () => {
    fakeClient(async () => deviceGrant, false);
    expect(await adapter().isAvailable('https://hs')).toBe(false);
  });

  it.each([
    ['a 404', () => new HTTPError('Not found', 404)],
    [
      'M_UNRECOGNIZED',
      () => new MatrixError({ errcode: 'M_UNRECOGNIZED' }, 404),
    ],
    [
      'invalid metadata',
      () =>
        new Error('Configured OAuth2 OP does not support required functions'),
    ],
  ])(
    'is false when the server has no auth metadata (%s)',
    async (_name, error) => {
      const client = fakeClient(async () => {
        throw error();
      });
      expect(await adapter().isAvailable('https://hs')).toBe(false);
      expect(client.stopClient).toHaveBeenCalled();
    },
  );

  it('rejects when the auth metadata cannot be fetched, and still stops the client', async () => {
    const client = fakeClient(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(adapter().isAvailable('https://hs')).rejects.toThrow(
      'Failed to fetch',
    );
    expect(client.stopClient).toHaveBeenCalled();
  });
});
