import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Capacitor } from '@capacitor/core';
import { AppSettingsService } from './app-settings.service';

const plugin = vi.hoisted(() => ({
  openAppSettings: vi.fn(),
  openNotificationSettings: vi.fn(),
  notificationPreviewSetting: vi.fn(),
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn(() => false),
    isPluginAvailable: vi.fn(() => false),
  },
  registerPlugin: vi.fn(() => plugin),
}));

const isNative = Capacitor.isNativePlatform as unknown as Mock;
const isAvailable = Capacitor.isPluginAvailable as unknown as Mock;

function service(): AppSettingsService {
  TestBed.configureTestingModule({ providers: [AppSettingsService] });
  return TestBed.inject(AppSettingsService);
}

describe('AppSettingsService', () => {
  beforeEach(() => {
    isNative.mockReturnValue(false);
    isAvailable.mockReturnValue(false);
    plugin.openAppSettings.mockReset().mockResolvedValue(undefined);
    plugin.openNotificationSettings.mockReset().mockResolvedValue(undefined);
    plugin.notificationPreviewSetting
      .mockReset()
      .mockResolvedValue({ value: null });
  });

  it('is unavailable off a native host and opens nothing', async () => {
    const svc = service();

    expect(svc.available).toBe(false);
    expect(await firstValueFrom(svc.openAppSettings())).toBe(false);
    expect(plugin.openAppSettings).not.toHaveBeenCalled();
  });

  it("opens Trinity's page in the system settings on a native host", async () => {
    isNative.mockReturnValue(true);
    isAvailable.mockReturnValue(true);
    const svc = service();

    expect(svc.available).toBe(true);
    expect(await firstValueFrom(svc.openAppSettings())).toBe(true);
    expect(isAvailable).toHaveBeenCalledWith('AppSettings');
    expect(plugin.openAppSettings).toHaveBeenCalledTimes(1);
  });

  it('reports false instead of throwing when the host refuses', async () => {
    isNative.mockReturnValue(true);
    isAvailable.mockReturnValue(true);
    plugin.openAppSettings.mockRejectedValue(new Error('no settings'));

    expect(await firstValueFrom(service().openAppSettings())).toBe(false);
  });

  describe('notification settings', () => {
    function native(): AppSettingsService {
      isNative.mockReturnValue(true);
      isAvailable.mockReturnValue(true);
      return service();
    }

    it("opens Trinity's notification settings on a native host", async () => {
      expect(await firstValueFrom(native().openNotificationSettings())).toBe(
        true,
      );
      expect(plugin.openNotificationSettings).toHaveBeenCalledTimes(1);
    });

    it('opens nothing off a native host', async () => {
      expect(await firstValueFrom(service().openNotificationSettings())).toBe(
        false,
      );
      expect(plugin.openNotificationSettings).not.toHaveBeenCalled();
    });

    it('reports false instead of throwing when the host refuses', async () => {
      plugin.openNotificationSettings.mockRejectedValue(new Error('no'));
      expect(await firstValueFrom(native().openNotificationSettings())).toBe(
        false,
      );
    });
  });

  describe('the lock-screen preview setting', () => {
    function native(): AppSettingsService {
      isNative.mockReturnValue(true);
      isAvailable.mockReturnValue(true);
      return service();
    }

    it.each([
      ['always', 'always'],
      ['whenUnlocked', 'when-unlocked'],
      ['never', 'never'],
    ] as const)('reads iOS’s %s as %s', async (value, expected) => {
      plugin.notificationPreviewSetting.mockResolvedValue({ value });
      expect(await firstValueFrom(native().previewSetting())).toBe(expected);
    });

    it('is unknown where the host cannot tell (Android)', async () => {
      plugin.notificationPreviewSetting.mockResolvedValue({ value: null });
      expect(await firstValueFrom(native().previewSetting())).toBeNull();
    });

    it('is unknown when the host answers with something else', async () => {
      const svc = native();
      plugin.notificationPreviewSetting.mockResolvedValue({
        value: 'sometimes',
      });
      expect(await firstValueFrom(svc.previewSetting())).toBeNull();
      plugin.notificationPreviewSetting.mockResolvedValue(undefined);
      expect(await firstValueFrom(svc.previewSetting())).toBeNull();
    });

    it('is unknown when the host refuses', async () => {
      plugin.notificationPreviewSetting.mockRejectedValue(new Error('no'));
      expect(await firstValueFrom(native().previewSetting())).toBeNull();
    });

    it('is unknown off a native host, without asking', async () => {
      expect(await firstValueFrom(service().previewSetting())).toBeNull();
      expect(plugin.notificationPreviewSetting).not.toHaveBeenCalled();
    });
  });
});
