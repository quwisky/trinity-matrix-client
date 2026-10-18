import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { QrSignInAdapter } from './qr-sign-in.adapter';
import { QrSignInAvailability } from './qr-sign-in-availability.service';

function setup(isAvailable: (url: string) => Promise<boolean>) {
  const adapter = { isAvailable: vi.fn(isAvailable) };
  TestBed.configureTestingModule({
    providers: [{ provide: QrSignInAdapter, useValue: adapter }],
  });
  return { adapter, service: TestBed.inject(QrSignInAvailability) };
}

describe('QrSignInAvailability', () => {
  it('reports what the adapter says', async () => {
    const { service } = setup(async (url) => url === 'https://yes');
    expect(await firstValueFrom(service.supports('https://yes'))).toBe(true);
    expect(await firstValueFrom(service.supports('https://no'))).toBe(false);
  });

  it('is cold', () => {
    const { adapter, service } = setup(async () => true);
    service.supports('https://a');
    expect(adapter.isAvailable).not.toHaveBeenCalled();
  });

  it('caches an answer per URL', async () => {
    const { adapter, service } = setup(async () => true);
    await firstValueFrom(service.supports('https://a'));
    await firstValueFrom(service.supports('https://a'));
    expect(adapter.isAvailable).toHaveBeenCalledTimes(1);
    await firstValueFrom(service.supports('https://b'));
    expect(adapter.isAvailable).toHaveBeenCalledTimes(2);
  });

  it('answers false on error and retries next time', async () => {
    let fail = true;
    const { adapter, service } = setup(async () => {
      if (fail) throw new Error('offline');
      return true;
    });
    expect(await firstValueFrom(service.supports('https://a'))).toBe(false);
    fail = false;
    expect(await firstValueFrom(service.supports('https://a'))).toBe(true);
    expect(adapter.isAvailable).toHaveBeenCalledTimes(2);
  });
});
