import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from './js-sdk/matrix-client.service';
import { TrustCryptoPort } from './trust-crypto.port';

function setup(clients: Record<string, unknown>) {
  const accountIds = signal<readonly string[]>(Object.keys(clients));
  TestBed.configureTestingModule({
    providers: [
      TrustCryptoPort,
      MockProvider(MatrixClientService, {
        activeUserId: signal<string | null>(null).asReadonly(),
        accountIds: accountIds.asReadonly(),
        clientFor: vi.fn((id: string) => (clients[id] ?? null) as never),
      }),
    ],
  });
  return { port: TestBed.inject(TrustCryptoPort), accountIds };
}

afterEach(() => TestBed.resetTestingModule());

describe('TrustCryptoPort', () => {
  it('lists every account with a live client', () => {
    const { port, accountIds } = setup({ '@a:hs': {}, '@b:hs': {} });

    expect(port.liveAccountIds()).toEqual(['@a:hs', '@b:hs']);
    accountIds.set(['@a:hs']);
    expect(port.liveAccountIds()).toEqual(['@a:hs']);
  });

  it('reads one live account’s client and crypto without making it active', () => {
    const crypto = { isCrossSigningReady: vi.fn() };
    const client = { getCrypto: () => crypto };
    const { port } = setup({ '@b:hs': client });

    expect(port.forAccount('@b:hs')).toEqual({ client, crypto });
    expect(port.activeAccountId()).toBeNull();
  });

  it('reports no crypto before it starts, and nothing for an account that is not live', () => {
    const client = { getCrypto: () => undefined };
    const { port } = setup({ '@b:hs': client });

    expect(port.forAccount('@b:hs')).toEqual({ client, crypto: null });
    expect(port.forAccount('@gone:hs')).toBeNull();
  });
});
