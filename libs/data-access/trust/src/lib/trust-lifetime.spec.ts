import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TrustCryptoPort } from '@trinity/data-access/matrix-client';
import { MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TrustLifetime } from './trust-lifetime';
import { TrustService } from './trust.service';
import { TrustVerificationService } from './trust-verification.service';

describe('TrustLifetime', () => {
  const activeAccountId = signal<string | null>('@a:example.org');
  const healthConnect = vi.fn();
  const healthDisconnect = vi.fn();
  const verificationConnect = vi.fn();
  const verificationDisconnect = vi.fn();

  beforeEach(() => {
    activeAccountId.set('@a:example.org');
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        TrustLifetime,
        MockProvider(TrustCryptoPort, {
          activeAccountId: activeAccountId.asReadonly(),
        }),
        MockProvider(TrustService, {
          connect: healthConnect,
          disconnect: healthDisconnect,
        }),
        MockProvider(TrustVerificationService, {
          connect: verificationConnect,
          disconnect: verificationDisconnect,
        }),
      ],
    });
  });

  it('is cold and retains both Trust projections until teardown', () => {
    const source = TestBed.inject(TrustLifetime).run();
    const prepared = vi.fn();

    expect(healthConnect).not.toHaveBeenCalled();
    expect(verificationConnect).not.toHaveBeenCalled();

    const lifetime = source.subscribe(prepared);

    expect(prepared).toHaveBeenCalledWith(undefined);
    expect(lifetime.closed).toBe(false);
    expect(healthConnect).toHaveBeenCalledOnce();
    expect(verificationConnect).toHaveBeenCalledOnce();

    lifetime.unsubscribe();

    expect(verificationDisconnect).toHaveBeenCalledOnce();
    expect(healthDisconnect).toHaveBeenCalledOnce();
  });

  it('reacquires projections when an Account appears after an empty set', () => {
    activeAccountId.set(null);
    const lifetime = TestBed.inject(TrustLifetime).run().subscribe();
    TestBed.tick();

    expect(healthConnect).toHaveBeenCalledOnce();
    expect(verificationConnect).toHaveBeenCalledOnce();

    activeAccountId.set('@b:example.org');
    TestBed.tick();

    expect(healthConnect).toHaveBeenCalledTimes(2);
    expect(verificationConnect).toHaveBeenCalledTimes(2);
    lifetime.unsubscribe();
  });

  it('uses the Observable error channel and cleans up a partial attachment', () => {
    const failure = new Error('broken Trust adapter');
    verificationConnect.mockImplementationOnce(() => {
      throw failure;
    });
    const error = vi.fn();

    TestBed.inject(TrustLifetime).run().subscribe({ error });

    expect(error).toHaveBeenCalledWith(failure);
    expect(verificationDisconnect).toHaveBeenCalledOnce();
    expect(healthDisconnect).toHaveBeenCalledOnce();
  });

  it('reports a broken Account reattachment through the same error channel', () => {
    const failure = new Error('broken Trust reattachment');
    const error = vi.fn();
    TestBed.inject(TrustLifetime).run().subscribe({ error });
    TestBed.tick();
    verificationConnect.mockImplementationOnce(() => {
      throw failure;
    });

    activeAccountId.set('@b:example.org');
    TestBed.tick();

    expect(error).toHaveBeenCalledWith(failure);
    expect(verificationDisconnect).toHaveBeenCalledOnce();
    expect(healthDisconnect).toHaveBeenCalledOnce();
  });
});
