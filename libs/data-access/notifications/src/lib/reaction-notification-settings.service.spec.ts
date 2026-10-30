import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { setupLiveNotificationSettings } from '../contract/live-notification-settings';
import { ReactionNotificationSettingsService } from './reaction-notification-settings.service';

const REACTIONS = 'dev.trinityproject.trinity.reaction_notifications';
const ALICE = '@alice:fake'; // the fake engine's one account with settings
const BOB = '@bob:fake';

function setup(options: { active?: string | null; live?: string[] } = {}) {
  const { engine, alice } = setupLiveNotificationSettings(options);
  return {
    svc: TestBed.inject(ReactionNotificationSettingsService),
    engine,
    alice,
    setPreference: vi.spyOn(engine, 'setPreference'),
  };
}

describe('ReactionNotificationSettingsService', () => {
  it('is off by default', () => {
    const { svc } = setup();
    expect(svc.isOn()).toBe(false);
    expect(svc.enabled()).toBe(false);
  });

  it('reads the active account and follows a change made elsewhere', () => {
    const { svc, engine } = setup();
    engine.writeAccountData(REACTIONS, { enabled: true });

    expect(svc.isOn()).toBe(true);
    expect(svc.enabled()).toBe(true);
  });

  it('reads the owning account when an account id is supplied', () => {
    const { svc, engine } = setup({ active: BOB, live: [ALICE, BOB] });
    engine.writeAccountData(REACTIONS, { enabled: true });

    expect(svc.isOn(ALICE)).toBe(true);
    expect(svc.enabled()).toBe(false);
  });

  it('writes the active account’s choice, cold', async () => {
    const { svc, alice, setPreference } = setup();
    const write = svc.setOn(true);
    expect(setPreference).not.toHaveBeenCalled();

    await firstValueFrom(write);

    expect(setPreference).toHaveBeenCalledWith(
      alice,
      'reactionNotifications',
      true,
    );
    expect(svc.enabled()).toBe(true);
  });

  it('rejects writes while signed out', async () => {
    const { svc } = setup({ active: null });
    await expect(firstValueFrom(svc.setOn(true))).rejects.toThrow(
      'Not signed in.',
    );
  });
});
