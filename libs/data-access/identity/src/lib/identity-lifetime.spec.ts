import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { IdentityMatrixPort } from '@trinity/data-access/matrix-client';
import { MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdentityLifetime } from './identity-lifetime';
import { IdentityPresenceService } from './identity-presence.service';

describe('IdentityLifetime', () => {
  const activeAccountId = signal<string | null>('@a:example.org');
  const connect = vi.fn();
  const disconnect = vi.fn();

  beforeEach(() => {
    activeAccountId.set('@a:example.org');
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        IdentityLifetime,
        MockProvider(IdentityMatrixPort, {
          activeAccountId: activeAccountId.asReadonly(),
        }),
        MockProvider(IdentityPresenceService, { connect, disconnect }),
      ],
    });
  });

  it('is cold and retains Identity presence until teardown', () => {
    const source = TestBed.inject(IdentityLifetime).run();
    const prepared = vi.fn();

    expect(connect).not.toHaveBeenCalled();

    const lifetime = source.subscribe(prepared);

    expect(prepared).toHaveBeenCalledWith(undefined);
    expect(lifetime.closed).toBe(false);
    expect(connect).toHaveBeenCalledOnce();

    lifetime.unsubscribe();

    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('reacquires presence when an Account appears after an empty set', () => {
    activeAccountId.set(null);
    const lifetime = TestBed.inject(IdentityLifetime).run().subscribe();
    TestBed.tick();

    expect(connect).toHaveBeenCalledOnce();

    activeAccountId.set('@b:example.org');
    TestBed.tick();

    expect(connect).toHaveBeenCalledTimes(2);
    lifetime.unsubscribe();
  });

  it('uses the Observable error channel and cleans up a failed attachment', () => {
    const failure = new Error('broken Identity adapter');
    connect.mockImplementationOnce(() => {
      throw failure;
    });
    const error = vi.fn();

    TestBed.inject(IdentityLifetime).run().subscribe({ error });

    expect(error).toHaveBeenCalledWith(failure);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('reports a broken Account reattachment through the same error channel', () => {
    const failure = new Error('broken Identity reattachment');
    const error = vi.fn();
    TestBed.inject(IdentityLifetime).run().subscribe({ error });
    TestBed.tick();
    connect.mockImplementationOnce(() => {
      throw failure;
    });

    activeAccountId.set('@b:example.org');
    TestBed.tick();

    expect(error).toHaveBeenCalledWith(failure);
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
