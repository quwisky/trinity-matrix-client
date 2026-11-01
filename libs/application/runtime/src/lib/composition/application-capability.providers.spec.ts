import type { FactoryProvider } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ACCOUNT_LIFECYCLE_PORT,
  type AccountLifecyclePort,
} from '@trinity/data-access/accounts';
import { OidcClientService } from '@trinity/data-access/auth';
import { DiagnosticLogService } from '@trinity/data-access/diagnostic-log';
import { AvatarService, MediaService } from '@trinity/data-access/media';
import {
  MentionIndexService,
  PushHandoffService,
  PushService,
} from '@trinity/data-access/notifications';
import {
  DraftStoreService,
  NativeTokenBridge,
  type BuildInfo,
} from '@trinity/platform-native';
import { PreferenceStoreService } from '@trinity/runtime/preferences';
import type { MatrixSession } from '@trinity/util/matrix';
import { MockProvider } from 'ng-mocks';
import { NEVER, firstValueFrom, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applicationCapabilityProviders } from './application-capability.providers';

const OIDC_SESSION: MatrixSession = {
  baseUrl: 'https://hs.example',
  userId: '@me:hs',
  deviceId: 'DEV',
  accessToken: 'at-1',
  refreshToken: 'rt-1',
  oidc: { issuer: 'https://op.example/', clientId: 'client-1' },
};

function lifecyclePort(
  nativeAnswer: 'revoked' | 'gone' | 'transient' = 'gone',
  mentionIndex: Partial<MentionIndexService> = {},
) {
  const revokeStored = vi.fn(() => of(nativeAnswer));
  const revokeTokens = vi.fn(() => of(void 0));
  const lifecycle = applicationCapabilityProviders({
    buildInfo: {} as BuildInfo,
    releaseNotes: [],
    pushConfig: null,
  }).find(
    (provider): provider is FactoryProvider =>
      'provide' in provider && provider.provide === ACCOUNT_LIFECYCLE_PORT,
  );
  TestBed.configureTestingModule({
    providers: [
      lifecycle!,
      MockProvider(AvatarService),
      MockProvider(MediaService),
      MockProvider(PushService),
      MockProvider(PushHandoffService),
      MockProvider(DraftStoreService),
      MockProvider(OidcClientService, { revokeTokens }),
      MockProvider(NativeTokenBridge, { revokeStored }),
      MockProvider(DiagnosticLogService),
      MockProvider(PreferenceStoreService),
      MockProvider(MentionIndexService, mentionIndex),
    ],
  });
  const port: AccountLifecyclePort = TestBed.inject(ACCOUNT_LIFECYCLE_PORT);
  return { port, revokeStored, revokeTokens };
}

describe('revokeProviderSession', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('revokes natively and not again at the provider when native revoked', async () => {
    const { port, revokeStored, revokeTokens } = lifecyclePort('revoked');

    await firstValueFrom(port.revokeProviderSession(OIDC_SESSION));

    expect(revokeStored).toHaveBeenCalledExactlyOnceWith(OIDC_SESSION);
    expect(revokeTokens).not.toHaveBeenCalled();
  });

  it('revokes at the provider and reports clean when native holds nothing', async () => {
    const { port, revokeStored, revokeTokens } = lifecyclePort('gone');

    await expect(
      firstValueFrom(port.revokeProviderSession(OIDC_SESSION)),
    ).resolves.toBeUndefined();

    expect(revokeStored).toHaveBeenCalledOnce();
    expect(revokeTokens).toHaveBeenCalledExactlyOnceWith(
      OIDC_SESSION.baseUrl,
      OIDC_SESSION.oidc,
      { accessToken: 'at-1', refreshToken: 'rt-1' },
    );
  });

  it('still revokes what it can, then fails the step, when native could not answer', async () => {
    const { port, revokeTokens } = lifecyclePort('transient');

    await expect(
      firstValueFrom(port.revokeProviderSession(OIDC_SESSION)),
    ).rejects.toThrow();

    expect(revokeTokens).toHaveBeenCalledExactlyOnceWith(
      OIDC_SESSION.baseUrl,
      OIDC_SESSION.oidc,
      { accessToken: 'at-1', refreshToken: 'rt-1' },
    );
  });

  it('asks neither for a password account', async () => {
    const { port, revokeStored, revokeTokens } = lifecyclePort('gone');

    await firstValueFrom(
      port.revokeProviderSession({ ...OIDC_SESSION, oidc: undefined }),
    );

    expect(revokeStored).not.toHaveBeenCalled();
    expect(revokeTokens).not.toHaveBeenCalled();
  });
});

describe('hasMentionHistory', () => {
  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it.each([
    [3, true],
    [0, false],
  ])('answers for a count of %i', async (count, expected) => {
    const { port } = lifecyclePort('gone', { count: () => of(count) });

    await expect(
      firstValueFrom(port.hasMentionHistory('@me:hs')),
    ).resolves.toBe(expected);
  });

  it('reads as false when the count fails', async () => {
    const { port } = lifecyclePort('gone', {
      count: () => throwError(() => new Error('store blocked')),
    });

    await expect(
      firstValueFrom(port.hasMentionHistory('@me:hs')),
    ).resolves.toBe(false);
  });

  it('reads as false when the count never answers', async () => {
    vi.useFakeTimers();
    const { port } = lifecyclePort('gone', { count: () => NEVER });

    const answer = firstValueFrom(port.hasMentionHistory('@me:hs'));
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(answer).resolves.toBe(false);
  });
});
