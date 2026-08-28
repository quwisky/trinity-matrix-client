import { Capacitor } from '@capacitor/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shouldPresentSettingsAsDialog } from './settings-dialog.config';

describe('shouldPresentSettingsAsDialog', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['web', 'Electron'])('uses a dialog on %s', () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);

    expect(shouldPresentSettingsAsDialog()).toBe(true);
  });

  it.each(['Android', 'iOS'])('uses the routed flow on %s', () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);

    expect(shouldPresentSettingsAsDialog()).toBe(false);
  });
});
