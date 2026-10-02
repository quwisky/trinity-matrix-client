import { DOCUMENT } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppIconAdapter } from './app-icon.adapter';

const plugin = vi.hoisted(() => ({ set: vi.fn(() => Promise.resolve()) }));
const desktop = vi.hoisted(() => ({
  set: vi.fn(() => Promise.resolve(true)),
  present: false,
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: vi.fn(() => 'web'),
    isPluginAvailable: vi.fn(() => true),
  },
  registerPlugin: () => plugin,
}));
vi.mock('./trinity-desktop-bridge', () => ({
  isElectronRenderer: () => desktop.present,
  getTrinityDesktopBridge: () =>
    desktop.present
      ? { capabilities: { appIcon: { set: desktop.set } } }
      : undefined,
}));

const platform = vi.mocked(Capacitor.getPlatform);

describe('AppIconAdapter', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    plugin.set.mockClear();
    desktop.set.mockClear();
    desktop.present = false;
    platform.mockReturnValue('web');
  });

  it('maps iOS explicit choices to alternate icons and system to the primary icon', async () => {
    platform.mockReturnValue('ios');
    const adapter = TestBed.inject(AppIconAdapter);
    await firstValueFrom(adapter.apply('dark', 'dark'));
    expect(plugin.set).toHaveBeenLastCalledWith({ name: 'AppIconDark' });
    await firstValueFrom(adapter.apply('dark', 'system'));
    expect(plugin.set).toHaveBeenLastCalledWith({ name: null });
    await firstValueFrom(adapter.apply('blurple', 'blurple'));
    expect(plugin.set).toHaveBeenLastCalledWith({ name: 'AppIconBlurple' });
  });

  it('does not re-send an unchanged icon', async () => {
    platform.mockReturnValue('ios');
    const adapter = TestBed.inject(AppIconAdapter);
    await firstValueFrom(adapter.apply('dark', 'system'));
    await firstValueFrom(adapter.apply('blurple', 'system'));
    expect(plugin.set).toHaveBeenCalledOnce();
  });

  it('ignores system on Android and sends explicit choices', async () => {
    platform.mockReturnValue('android');
    const adapter = TestBed.inject(AppIconAdapter);
    await firstValueFrom(adapter.apply('dark', 'system'));
    expect(plugin.set).not.toHaveBeenCalled();
    await firstValueFrom(adapter.apply('dark', 'dark'));
    expect(plugin.set).toHaveBeenCalledWith({ name: 'dark' });
  });

  it('retries after a failed native call', async () => {
    platform.mockReturnValue('android');
    plugin.set.mockRejectedValueOnce(new Error('denied'));
    const adapter = TestBed.inject(AppIconAdapter);
    await expect(firstValueFrom(adapter.apply('dark', 'dark'))).rejects.toThrow(
      'denied',
    );
    await firstValueFrom(adapter.apply('dark', 'dark'));
    expect(plugin.set).toHaveBeenCalledTimes(2);
  });

  it('sends the resolved icon to the desktop host', async () => {
    desktop.present = true;
    const adapter = TestBed.inject(AppIconAdapter);
    await firstValueFrom(adapter.apply('dark', 'system'));
    expect(desktop.set).toHaveBeenCalledWith('dark');
    expect(plugin.set).not.toHaveBeenCalled();
  });

  it('swaps and restores the web favicons', async () => {
    const doc = TestBed.inject(DOCUMENT);
    doc.head.innerHTML =
      '<link rel="icon" type="image/svg+xml" href="assets/icon/favicon.svg">' +
      '<link rel="icon" type="image/png" href="assets/icon/favicon.png">';
    const adapter = TestBed.inject(AppIconAdapter);
    const links = () =>
      [...doc.querySelectorAll('link[rel="icon"]')].map((l) => [
        l.getAttribute('type'),
        l.getAttribute('href'),
      ]);

    await firstValueFrom(adapter.apply('dark', 'dark'));
    expect(links()).toEqual([
      ['image/png', 'assets/icon/favicon-dark.png'],
      ['image/png', 'assets/icon/favicon-dark.png'],
    ]);
    await firstValueFrom(adapter.apply('blurple', 'system'));
    expect(links()).toEqual([
      ['image/svg+xml', 'assets/icon/favicon.svg'],
      ['image/png', 'assets/icon/favicon.png'],
    ]);
  });
});
