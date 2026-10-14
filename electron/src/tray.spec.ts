import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { Tray, setToolTip, buildFromTemplate } = vi.hoisted(() => {
  const setToolTip = vi.fn();
  return {
    setToolTip,
    buildFromTemplate: vi.fn((template: unknown) => template),
    Tray: vi.fn(function () {
      return { setToolTip, setContextMenu: vi.fn(), on: vi.fn() };
    }),
  };
});
vi.mock('electron', () => ({
  Menu: { buildFromTemplate },
  nativeImage: { createEmpty: vi.fn(() => ({})), createFromPath: vi.fn() },
  Tray,
}));
vi.mock('./icons', () => ({
  iconCandidatePaths: () => [],
  trayIconFile: () => 'trinityTray.png',
}));
vi.mock('./window', () => ({ focusMainWindow: vi.fn(), requestQuit: vi.fn() }));
vi.mock('./app-identity', async () => {
  const { CHANNEL_IDENTITY } = await import('./release-channel');
  return { appIdentity: () => CHANNEL_IDENTITY.next };
});

import { createTray } from './tray';

describe('tray', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("names the app's tray entry, since both apps share the tray icon", () => {
    createTray();
    expect(setToolTip).toHaveBeenCalledExactlyOnceWith('Trinity Next');
    const template = buildFromTemplate.mock.calls[0]?.[0] as {
      label?: string;
    }[];
    expect(template[0]?.label).toBe('Open Trinity Next');
  });
});
