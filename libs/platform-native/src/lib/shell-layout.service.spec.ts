import { TestBed } from '@angular/core/testing';
import { Preferences } from '@capacitor/preferences';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RIGHT_PANEL_WIDTH,
  DEFAULT_SIDEBAR_WIDTH,
  RIGHT_PANEL_WIDTH_BOUNDS,
  SIDEBAR_WIDTH_BOUNDS,
  ShellLayoutService,
} from './shell-layout.service';

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(), set: vi.fn() },
}));

type PreferenceSet = typeof Preferences.set;
const preferencePlugin = Preferences as unknown as { set: PreferenceSet };

/** Let Node report a promise that finishes the turn without a rejection handler. */
const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/**
 * What this service is FOR is the clamping, so that is most of what is tested here.
 *
 * A pane width arrives from two places that cannot be trusted to agree with this screen: a
 * drag, which is bounded by the handle but only while the handle is the thing writing, and a
 * hand-edited config document, which is arbitrary. Both go through here, so the bounds hold
 * once rather than at each call site.
 */
describe('ShellLayoutService', () => {
  let service: ShellLayoutService;
  const stored = new Map<string, string>();

  beforeEach(() => {
    stored.clear();
    vi.mocked(Preferences.get).mockImplementation(({ key }) =>
      Promise.resolve({ value: stored.get(key) ?? null }),
    );
    vi.mocked(Preferences.set).mockImplementation(({ key, value }) => {
      stored.set(key, value);
      return Promise.resolve();
    });
    service = TestBed.configureTestingModule({}).inject(ShellLayoutService);
  });

  it('ships the widths the shell has always had', () => {
    expect(service.sidebarWidth()).toBe(DEFAULT_SIDEBAR_WIDTH);
    expect(service.rightPanelWidth()).toBe(DEFAULT_RIGHT_PANEL_WIDTH);
  });

  it('clamps a width to its bounds rather than storing what it was given', () => {
    service.setSidebarWidth(5_000);
    expect(service.sidebarWidth()).toBe(SIDEBAR_WIDTH_BOUNDS.max);

    service.setSidebarWidth(1);
    expect(service.sidebarWidth()).toBe(SIDEBAR_WIDTH_BOUNDS.min);

    service.setRightPanelWidth(-40);
    expect(service.rightPanelWidth()).toBe(RIGHT_PANEL_WIDTH_BOUNDS.min);
  });

  it('rounds, because a pane is laid out in whole pixels', () => {
    service.setSidebarWidth(341.7);

    expect(service.sidebarWidth()).toBe(342);
  });

  it('persists what it clamped, not what it was asked for', () => {
    // Storing the raw value would restore an out-of-bounds pane on the next launch, on a
    // screen that may be smaller still.
    service.setSidebarWidth(5_000);

    expect(stored.get('trinity.shell.sidebar-width')).toBe(
      String(SIDEBAR_WIDTH_BOUNDS.max),
    );
  });

  it('keeps both session widths without leaking a rejected persistence write', async () => {
    // A plain function is deliberate: Vitest attaches a handler to promises returned from
    // vi.fn() so it can record settledResults, which would hide the unhandled rejection this
    // test exists to catch. This is the native-storage failure rather than a mock artifact.
    const originalSet = preferencePlugin.set;
    const escaped: unknown[] = [];
    const record = (reason: unknown) => escaped.push(reason);
    let calls = 0;
    preferencePlugin.set = () => {
      calls += 1;
      return Promise.reject(new Error('storage unavailable'));
    };
    process.on('unhandledRejection', record);

    try {
      service.setSidebarWidth(5_000);
      service.setRightPanelWidth(-40);

      // The signal is authoritative for this session and updates before persistence settles.
      expect(service.sidebarWidth()).toBe(SIDEBAR_WIDTH_BOUNDS.max);
      expect(service.rightPanelWidth()).toBe(RIGHT_PANEL_WIDTH_BOUNDS.min);

      await flush();

      expect(calls).toBe(2);
      expect(escaped).toEqual([]);
    } finally {
      process.off('unhandledRejection', record);
      preferencePlugin.set = originalSet;
    }
  });

  it('restores both widths on init', async () => {
    stored.set('trinity.shell.sidebar-width', '420');
    stored.set('trinity.shell.right-panel-width', '600');

    await service.init();

    expect(service.sidebarWidth()).toBe(420);
    expect(service.rightPanelWidth()).toBe(600);
  });

  it('keeps the default when nothing is stored', async () => {
    // `Number(null)` is 0, which would clamp to the MINIMUM — a pane nobody chose, and the
    // failure mode a missing key would otherwise produce silently.
    await service.init();

    expect(service.sidebarWidth()).toBe(DEFAULT_SIDEBAR_WIDTH);
    expect(service.rightPanelWidth()).toBe(DEFAULT_RIGHT_PANEL_WIDTH);
  });

  it.each([
    ['an empty string', ''],
    ['not a number', 'wide'],
    ['infinity', 'Infinity'],
  ])('keeps the default when the stored value is %s', async (_l, value) => {
    stored.set('trinity.shell.sidebar-width', value);

    await service.init();

    expect(service.sidebarWidth()).toBe(DEFAULT_SIDEBAR_WIDTH);
  });

  it('clamps a stored value that is out of bounds for this screen', async () => {
    stored.set('trinity.shell.sidebar-width', '9000');

    await service.init();

    expect(service.sidebarWidth()).toBe(SIDEBAR_WIDTH_BOUNDS.max);
  });

  it('keeps the default when storage itself fails', async () => {
    vi.mocked(Preferences.get).mockRejectedValue(new Error('no storage'));

    await service.init();

    expect(service.sidebarWidth()).toBe(DEFAULT_SIDEBAR_WIDTH);
  });
});
