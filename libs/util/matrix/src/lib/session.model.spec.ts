import { cryptoBackendFor } from './session.model';

describe('cryptoBackendFor', () => {
  it.each([
    // nativeAvailable, mark, newDevice → backend
    [true, undefined, true, 'native'],
    [true, 'native', true, 'native'],
    [false, undefined, true, 'wasm'],
    [false, 'native', true, 'wasm'],
    [true, 'native', false, 'native'],
    [true, undefined, false, 'refuse'],
    [false, 'native', false, 'refuse'],
    [false, undefined, false, 'wasm'],
  ] as const)(
    'native %s, mark %s, new device %s: %s',
    (nativeAvailable, mark, newDevice, backend) => {
      expect(cryptoBackendFor({ nativeAvailable, mark, newDevice })).toBe(
        backend,
      );
    },
  );

  it('keeps a session saved before the mark existed on WASM', () => {
    const stored = JSON.parse(
      '{"baseUrl":"https://hs","userId":"@a:hs","deviceId":"D","cryptoStoreKeyed":true}',
    ) as { cryptoBackend?: 'native' };
    expect(
      cryptoBackendFor({
        nativeAvailable: false,
        mark: stored.cryptoBackend,
        newDevice: false,
      }),
    ).toBe('wasm');
  });
});
