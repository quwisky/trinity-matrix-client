import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import {
  CryptoBackendMismatchError,
  type NativeCryptoHost,
  NativeCryptoService,
} from './native-crypto.service';

function service(host: NativeCryptoHost | null) {
  const svc = TestBed.inject(NativeCryptoService);
  vi.spyOn(svc, 'host').mockResolvedValue(host);
  return svc;
}

const nativeHost = () =>
  ({
    install: vi.fn(async () => undefined),
    deleteStore: vi.fn(async () => {
      throw new Error('gone');
    }),
  }) as unknown as NativeCryptoHost & {
    install: ReturnType<typeof vi.fn>;
  };

describe('NativeCryptoService', () => {
  it('installs the shim for a native session on a native host', async () => {
    const host = nativeHost();
    expect(await service(host).prepare('native')).toBe(host);
    expect(host.install).toHaveBeenCalledTimes(1);
  });

  it('opens an unmarked session on WASM where crypto is not native', async () => {
    expect(await service(null).prepare(undefined)).toBeNull();
  });

  it('refuses a session made by the other backend, opening nothing', async () => {
    const host = nativeHost();
    await expect(service(host).prepare(undefined)).rejects.toBeInstanceOf(
      CryptoBackendMismatchError,
    );
    expect(host.install).not.toHaveBeenCalled();
    await expect(service(null).prepare('native')).rejects.toThrow(
      /sign out and in again on this build/,
    );
  });

  it('deletes a store best-effort and is a no-op where crypto is not native', async () => {
    await expect(
      service(nativeHost()).deleteStore('@a:hs', 'D'),
    ).resolves.toBeUndefined();
    await expect(
      service(null).deleteStore('@a:hs', 'D'),
    ).resolves.toBeUndefined();
  });

  it('runs on WASM off Android without loading the plugin', async () => {
    expect(await TestBed.inject(NativeCryptoService).host()).toBeNull();
  });
});
