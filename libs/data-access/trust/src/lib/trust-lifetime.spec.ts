import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TrustCryptoPort } from '@trinity/data-access/matrix-client';
import { ProjectionRuntime } from '@trinity/runtime/projection';
import { MockProvider } from 'ng-mocks';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TrustLifetime } from './trust-lifetime';
import { TrustOperationError } from './trust-operation-error';
import { TrustService } from './trust.service';
import { TrustVerificationService } from './trust-verification.service';

describe('TrustLifetime', () => {
  const activeAccountId = signal<string | null>('@a:example.org');
  const healthConnect = vi.fn();
  const healthDisconnect = vi.fn();
  const verificationConnect = vi.fn();
  const verificationDisconnect = vi.fn();
  const refresh = vi.fn(() => of(void 0));

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
          refresh,
        }),
        MockProvider(TrustVerificationService, {
          connect: verificationConnect,
          disconnect: verificationDisconnect,
        }),
        MockProvider(ProjectionRuntime, {
          waitFor: () => of(readiness()),
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

    expect(healthConnect).not.toHaveBeenCalled();
    expect(verificationConnect).not.toHaveBeenCalled();

    activeAccountId.set('@b:example.org');
    TestBed.tick();

    expect(healthConnect).toHaveBeenCalledOnce();
    expect(verificationConnect).toHaveBeenCalledOnce();
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

  it('surfaces an expected health preparation failure for runtime classification', () => {
    const failure = new TrustOperationError(
      'refresh-health',
      'server-failure',
      'retry',
      'Trust health is temporarily unavailable.',
    );
    refresh.mockReturnValueOnce(throwError(() => failure));
    const error = vi.fn();

    TestBed.inject(TrustLifetime).run().subscribe({ error });

    expect(error).toHaveBeenCalledWith(failure);
    expect(verificationDisconnect).toHaveBeenCalledOnce();
    expect(healthDisconnect).toHaveBeenCalledOnce();
  });
});

function readiness() {
  return {
    scope: { kind: 'active-account' } as const,
    durationMs: 0,
    projectionCount: 2,
    listenerCount: 2,
    retainedBytes: 0,
    acknowledgements: [],
  };
}
