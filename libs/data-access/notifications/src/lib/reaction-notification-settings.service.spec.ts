import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  REACTION_NOTIFICATION_EVENT,
  ReactionNotificationSettingsService,
} from './reaction-notification-settings.service';

function setup(
  options: {
    stored?: unknown;
    initialized?: boolean;
    perAccount?: Record<string, unknown>;
  } = {},
) {
  TestBed.resetTestingModule();
  const writes: Array<{ type: string; content: unknown; resolve: () => void }> =
    [];
  const client = {
    getAccountData: vi.fn(() =>
      options.stored === undefined
        ? undefined
        : { getContent: () => options.stored },
    ),
    setAccountData: vi.fn((type: string, content: unknown) => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => (resolve = done));
      writes.push({ type, content, resolve });
      return promise;
    }),
    on: vi.fn(),
    off: vi.fn(),
  };
  let activeClient = client;
  TestBed.configureTestingModule({
    providers: [
      ReactionNotificationSettingsService,
      MockProvider(MatrixClientService, {
        isInitialized: options.initialized ?? true,
        get instance() {
          return activeClient as never;
        },
        clientFor: ((accountId: string) => {
          const stored = options.perAccount?.[accountId];
          return stored === undefined
            ? null
            : ({
                getAccountData: () => ({ getContent: () => stored }),
              } as never);
        }) as never,
      }),
    ],
  });
  return {
    service: TestBed.inject(ReactionNotificationSettingsService),
    client,
    writes,
    switchClient: (next: typeof client) => (activeClient = next),
  };
}

describe('ReactionNotificationSettingsService', () => {
  it('defaults absent and malformed account data to off', () => {
    for (const stored of [
      undefined,
      {},
      { enabled: 'yes' },
      { enabled: null },
      null,
    ]) {
      expect(setup({ stored }).service.isOn()).toBe(false);
    }
  });

  it('reads the active account preference', () => {
    expect(setup({ stored: { enabled: true } }).service.isOn()).toBe(true);
  });

  it('reads the owning account when an account id is supplied', () => {
    const { service } = setup({
      stored: { enabled: true },
      perAccount: { '@quiet:hs': { enabled: false } },
    });
    expect(service.isOn('@quiet:hs')).toBe(false);
    expect(service.isOn('@missing:hs')).toBe(false);
  });

  it('does not write until the returned observable is subscribed', () => {
    const { service, client } = setup();
    const write$ = service.setOn(true);
    expect(client.setAccountData).not.toHaveBeenCalled();
    write$.subscribe();
    expect(client.setAccountData).toHaveBeenCalledWith(
      REACTION_NOTIFICATION_EVENT,
      {
        enabled: true,
      },
    );
  });

  it('rejects writes while signed out', async () => {
    await expect(
      firstValueFrom(setup({ initialized: false }).service.setOn(true)),
    ).rejects.toThrow();
  });

  it('updates the signal from account-data events while connected', () => {
    const { service, client } = setup({ stored: { enabled: false } });
    service.connect();
    const callback = client.on.mock.calls[0]?.[1] as (() => void) | undefined;
    expect(callback).toBeTypeOf('function');
    (client.getAccountData as ReturnType<typeof vi.fn>).mockReturnValue({
      getContent: () => ({ enabled: true }),
    });
    callback?.();
    expect(service.enabled()).toBe(true);
  });

  it('removes the account-data listener when disconnected', () => {
    const { service, client } = setup();
    service.connect();
    service.disconnect();
    expect(client.off).toHaveBeenCalledWith(...client.on.mock.calls[0]);
  });

  it('does not let a late write completion change a switched account projection', async () => {
    const first = setup({ stored: { enabled: false } });
    const active = first.service;
    const firstWrite = active.setOn(true);
    firstWrite.subscribe();
    expect(first.writes).toHaveLength(1);
    const second = {
      getAccountData: vi.fn(() => ({ getContent: () => ({ enabled: false }) })),
      setAccountData: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      off: vi.fn(),
    };
    first.switchClient(second);
    active.connect();
    first.writes[0].resolve();
    await vi.waitFor(() => expect(active.enabled()).toBe(false));
  });
});
