import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { EngineRequestError, engineFail } from '@trinity/util/matrix';
import { setupLiveNotificationSettings } from '../contract/live-notification-settings';
import { NotificationSoundService } from './notification-sound.service';

const SOUND = 'dev.trinityproject.trinity.notification_sound';
const ALICE = '@alice:fake'; // the fake engine's one account with settings
const BOB = '@bob:fake';

function setup(options: { active?: string | null; live?: string[] } = {}) {
  const { engine, alice } = setupLiveNotificationSettings(options);
  return {
    svc: TestBed.inject(NotificationSoundService),
    engine,
    alice,
    setPreference: vi.spyOn(engine, 'setPreference'),
  };
}

describe('NotificationSoundService', () => {
  it('is on by default — the Matrix default is audible', () => {
    const { svc } = setup();
    expect(svc.isOn()).toBe(true);
    expect(svc.enabled()).toBe(true);
  });

  it('reads the stored preference and follows a change made elsewhere', () => {
    const { svc, engine } = setup();
    engine.writeAccountData(SOUND, { enabled: false });

    expect(svc.isOn()).toBe(false);
    expect(svc.enabled()).toBe(false);
  });

  it('reads the OWNING account, not whichever one is active', () => {
    const { svc, engine } = setup({ active: BOB, live: [ALICE, BOB] });
    engine.writeAccountData(SOUND, { enabled: false });

    expect(svc.isOn(ALICE)).toBe(false);
    expect(svc.isOn()).toBe(true);
  });

  it('falls back to the default for an account without settings, and before sign-in', () => {
    expect(setup().svc.isOn('@unknown:fake')).toBe(true);
    TestBed.resetTestingModule();
    expect(setup({ active: null }).svc.isOn()).toBe(true);
  });

  it('persists the active account’s choice, cold, and reads it at once', async () => {
    const { svc, engine, alice, setPreference } = setup();
    const write = svc.setOn(false);
    expect(setPreference).not.toHaveBeenCalled();

    await firstValueFrom(write);

    expect(setPreference).toHaveBeenCalledWith(alice, 'sound', false);
    expect(engine.readAccountData(SOUND)).toEqual({ enabled: false });
    expect(svc.enabled()).toBe(false);
  });

  it('refuses to write when signed out', async () => {
    const { svc, setPreference } = setup({ active: null });
    await expect(firstValueFrom(svc.setOn(false))).rejects.toThrow(
      'Not signed in.',
    );
    expect(setPreference).not.toHaveBeenCalled();
  });

  it('reports a refused write', async () => {
    const { svc, setPreference } = setup();
    setPreference.mockReturnValue(
      of(
        engineFail({
          kind: 'http',
          code: 'request-failed',
          diagnostic: { kind: 'http', httpStatus: 500 },
        }),
      ),
    );

    await expect(firstValueFrom(svc.setOn(false))).rejects.toThrow(
      EngineRequestError,
    );
    expect(svc.isOn()).toBe(true);
  });
});
