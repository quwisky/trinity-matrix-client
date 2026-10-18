import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { createClient } from 'matrix-js-sdk';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { MatrixClientService } from './matrix-client.service';
import {
  CryptoStoreKeyService,
  SessionStorageService,
} from '@trinity/platform-native';
import { ProjectionRuntime } from '@trinity/runtime/projection';

export const SESSION = {
  baseUrl: 'https://hs.example',
  userId: '@me:hs',
  deviceId: 'DEV',
  accessToken: 'tok',
};
export const SESSION_B = {
  baseUrl: 'https://other.example',
  userId: '@you:other',
  deviceId: 'DEV2',
  accessToken: 'tok2',
};
// An OIDC ("next-gen auth") session: refresh token + expiry + provider binding.
export const OIDC_SESSION = {
  ...SESSION,
  refreshToken: 'refresh-tok',
  accessTokenExpiresAt: 1234,
  oidc: {
    issuer: 'https://op.example/',
    clientId: 'client-1',
    redirectUri: 'https://app/sso-callback',
    idTokenClaims: {
      iss: 'https://op.example/',
      sub: 'u',
      aud: 'client-1',
      exp: 1,
      iat: 0,
    },
  },
};

export function fakeClient(baseUrl = 'https://hs.example') {
  return {
    baseUrl,
    on: vi.fn(),
    off: vi.fn(),
    initRustCrypto: vi.fn().mockResolvedValue(undefined),
    startClient: vi.fn().mockResolvedValue(undefined),
    stopClient: vi.fn(),
    clearStores: vi.fn().mockResolvedValue(undefined),
    getCrypto: vi.fn().mockReturnValue(undefined),
  };
}

// `clients` are what createClient returns: one -> every call, several -> one per call in order.
export function setup(...clients: ReturnType<typeof fakeClient>[]) {
  if (clients.length === 1) {
    vi.mocked(createClient).mockReturnValue(clients[0] as never);
  } else {
    for (const client of clients) {
      vi.mocked(createClient).mockReturnValueOnce(client as never);
    }
  }
  TestBed.configureTestingModule({
    providers: [
      MatrixClientService,
      MockProvider(SessionStorageService),
      MockProvider(CryptoStoreKeyService),
    ],
  });
  const svc = TestBed.inject(MatrixClientService);
  const storage = TestBed.inject(SessionStorageService);
  const projections = TestBed.inject(ProjectionRuntime);
  const storeKeys = TestBed.inject(CryptoStoreKeyService);
  // Default: no key reads back (the tests that open keyed stores say otherwise).
  vi.mocked(storeKeys.read).mockResolvedValue({ kind: 'missing' });
  // Default: no persisted session (mirrors the original hand-rolled stub); the
  // save/clear observables aren't exercised by these paths.
  vi.mocked(storage.load).mockReturnValue(of(null));
  // A wipe of a non-live account reads its registry record for the crypto prefix.
  vi.mocked(storage.record).mockReturnValue(of(null));
  return { svc, storage, projections, storeKeys };
}
