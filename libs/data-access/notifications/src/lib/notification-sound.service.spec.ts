import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  NOTIFICATION_SOUND_EVENT,
  NotificationSoundService,
} from './notification-sound.service';

function setup(
  opts: { stored?: unknown; initialized?: boolean; instance?: unknown } = {},
) {
  // Several tests build more than one service, and TestBed refuses to be reconfigured once
  // instantiated.
  TestBed.resetTestingModule();
  const setAccountData = vi.fn().mockResolvedValue({});
  const getAccountData = vi.fn((type: string) =>
    type === NOTIFICATION_SOUND_EVENT && opts.stored !== undefined
      ? { getContent: () => opts.stored }
      : undefined,
  );
  TestBed.configureTestingModule({
    providers: [
      NotificationSoundService,
      MockProvider(MatrixClientService, {
        isInitialized: opts.initialized ?? true,
        instance: ('instance' in opts
          ? opts.instance
          : { getAccountData, setAccountData }) as never,
      }),
    ],
  });
  return { svc: TestBed.inject(NotificationSoundService), setAccountData };
}

describe('NotificationSoundService', () => {
  it('is on by default — the Matrix default is audible', () => {
    expect(setup().svc.isOn()).toBe(true);
  });

  it('reads the stored preference', () => {
    expect(setup({ stored: { enabled: false } }).svc.isOn()).toBe(false);
    expect(setup({ stored: { enabled: true } }).svc.isOn()).toBe(true);
  });

  it('falls back to the default for content that is not a boolean', () => {
    // Written by another client, or half-migrated. Anything unrecognised must not read as
    // "silent" — a setting that silently swallows notifications is worse than one that
    // ignores a bad value.
    for (const stored of [{}, { enabled: 'yes' }, { enabled: null }, null]) {
      expect(setup({ stored }).svc.isOn(), JSON.stringify(stored)).toBe(true);
    }
  });

  it('persists to account data', async () => {
    const { svc, setAccountData } = setup();

    await firstValueFrom(svc.setOn(false));

    expect(setAccountData).toHaveBeenCalledWith(NOTIFICATION_SOUND_EVENT, {
      enabled: false,
    });
  });

  it('never throws while a notification is being built', () => {
    // isOn() runs inside show(); a throw here would stop the notification appearing at all
    // rather than surfacing as a broken setting. Signed out, and a client that exposes no
    // account-data accessor, both have to degrade to the default.
    expect(setup({ initialized: false }).svc.isOn()).toBe(true);
    expect(setup({ instance: undefined }).svc.isOn()).toBe(true);
    expect(setup({ instance: {} }).svc.isOn()).toBe(true);
  });

  it('refuses to write when signed out', async () => {
    await expect(
      firstValueFrom(setup({ initialized: false }).svc.setOn(false)),
    ).rejects.toThrow();
  });
});
