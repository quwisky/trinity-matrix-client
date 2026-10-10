import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Capacitor } from '@capacitor/core';
import { AppSettingsService } from './app-settings.service';

const plugin = vi.hoisted(() => ({ openAppSettings: vi.fn() }));
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
});
