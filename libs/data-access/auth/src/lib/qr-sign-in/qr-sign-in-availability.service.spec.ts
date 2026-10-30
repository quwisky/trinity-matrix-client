import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { FakeAuthEngine } from '../../contract/fake-auth-engine';
import { AUTH_ENGINE } from '../auth-engine.token';
import { QrSignInAvailability } from './qr-sign-in-availability.service';

function setup() {
  const engine = new FakeAuthEngine();
  const probe = vi.spyOn(engine, 'supportsQrRendezvous');
  TestBed.configureTestingModule({
    providers: [{ provide: AUTH_ENGINE, useValue: engine }],
  });
  return { engine, probe, service: TestBed.inject(QrSignInAvailability) };
}

describe('QrSignInAvailability', () => {
  it('reports what the engine says', async () => {
    const { engine, service } = setup();
    engine.qrRendezvous = true;
    expect(await firstValueFrom(service.supports('https://yes'))).toBe(true);
    engine.qrRendezvous = false;
    expect(await firstValueFrom(service.supports('https://no'))).toBe(false);
  });

  it('is cold', () => {
    const { probe, service } = setup();
    service.supports('https://a');
    expect(probe).not.toHaveBeenCalled();
  });

  it('caches an answer per URL', async () => {
    const { probe, service } = setup();
    await firstValueFrom(service.supports('https://a'));
    await firstValueFrom(service.supports('https://a'));
    expect(probe).toHaveBeenCalledTimes(1);
    await firstValueFrom(service.supports('https://b'));
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('shares one probe between concurrent subscribers', async () => {
    const { engine, probe, service } = setup();
    engine.qrRendezvous = true;
    const answers = await Promise.all([
      firstValueFrom(service.supports('https://a')),
      firstValueFrom(service.supports('https://a')),
    ]);
    expect(answers).toEqual([true, true]);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('answers false when the server cannot be asked, and asks again next time', async () => {
    const { engine, probe, service } = setup();
    engine.qrRendezvous = true;
    engine.failure = {
      kind: 'network',
      code: 'request-failed',
      diagnostic: { kind: 'network' },
    };
    expect(await firstValueFrom(service.supports('https://a'))).toBe(false);
    engine.failure = null;
    expect(await firstValueFrom(service.supports('https://a'))).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
