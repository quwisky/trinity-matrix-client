import { TestBed } from '@angular/core/testing';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { Preferences } from '@capacitor/preferences';
import { Capacitor } from '@capacitor/core';
import { StatusBar } from '@capacitor/status-bar';
import { ThemeService } from './theme.service';

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(), set: vi.fn() },
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn(() => false),
    isPluginAvailable: vi.fn(() => true),
  },
}));
vi.mock('@capacitor/status-bar', () => ({
  StatusBar: { setStyle: vi.fn(() => Promise.resolve()) },
  Style: { Dark: 'DARK', Light: 'LIGHT', Default: 'DEFAULT' },
}));

const get = Preferences.get as unknown as Mock;
const set = Preferences.set as unknown as Mock;
const isNative = Capacitor.isNativePlatform as unknown as Mock;
const setStyle = StatusBar.setStyle as unknown as Mock;

/** A controllable fake of the prefers-color-scheme media query. */
interface FakeMql {
  matches: boolean;
  addEventListener: Mock;
  removeEventListener: Mock;
  fire: () => void;
}

describe('ThemeService', () => {
  let mql: FakeMql;
  let origMatchMedia: typeof window.matchMedia;

  function makeMql(matches: boolean): FakeMql {
    let handler: (() => void) | undefined;
    return {
      matches,
      addEventListener: vi.fn((_event: string, h: () => void) => {
        handler = h;
      }),
      removeEventListener: vi.fn(),
      fire: () => handler?.(),
    };
  }

  beforeEach(() => {
    get.mockReset().mockResolvedValue({ value: null });
    set.mockReset().mockResolvedValue(undefined);
    isNative.mockReturnValue(false); // web by default
    setStyle.mockClear().mockResolvedValue(undefined);
    mql = makeMql(false); // system = light by default
    origMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn(
      () => mql as unknown as MediaQueryList,
    ) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    window.matchMedia = origMatchMedia;
    document.documentElement.classList.remove('dark');
    document.documentElement.removeAttribute('data-theme');
  });

  function service(): ThemeService {
    TestBed.configureTestingModule({ providers: [ThemeService] });
    return TestBed.inject(ThemeService);
  }

  // The dark palette is the `.dark` class on <html> (light is default).
  const isDark = () => document.documentElement.classList.contains('dark');
  // The active palette is the `data-theme` attribute (absent for the default).
  const paletteAttr = () => document.documentElement.getAttribute('data-theme');

  it('defaults to following the system, resolving light when the OS is light', async () => {
    const svc = service();
    await svc.init();

    expect(svc.preference()).toBe('system');
    expect(svc.resolved()).toBe('light');
    expect(isDark()).toBe(false);
  });

  it('follows the system to dark (sets the dark class) when the OS is dark', async () => {
    mql = makeMql(true);
    const svc = service();
    await svc.init();

    expect(svc.resolved()).toBe('dark');
    expect(isDark()).toBe(true);
  });

  it('restores a saved preference and applies it regardless of the OS', async () => {
    get.mockResolvedValue({ value: 'dark' });
    mql = makeMql(false); // OS light, but the saved preference is dark
    const svc = service();
    await svc.init();

    expect(svc.preference()).toBe('dark');
    expect(svc.resolved()).toBe('dark');
    expect(isDark()).toBe(true);
  });

  it('setPreference applies and persists the choice', async () => {
    const svc = service();
    await svc.init();

    svc.setPreference('light');
    expect(svc.resolved()).toBe('light');
    expect(isDark()).toBe(false);
    expect(set).toHaveBeenCalledWith({ key: 'trinity.theme', value: 'light' });

    svc.setPreference('dark');
    expect(svc.resolved()).toBe('dark');
    expect(isDark()).toBe(true);
  });

  it('reacts to a system theme change only while following the system', async () => {
    const svc = service();
    await svc.init(); // system, OS light → resolved light
    expect(svc.resolved()).toBe('light');

    // OS flips to dark → service follows.
    mql.matches = true;
    mql.fire();
    expect(svc.resolved()).toBe('dark');
    expect(isDark()).toBe(true);

    // Pin to light: a later OS change must NOT override the explicit choice.
    svc.setPreference('light');
    mql.matches = false;
    mql.fire();
    expect(svc.resolved()).toBe('light');
    expect(isDark()).toBe(false);
  });

  it('matches the native status bar to the resolved theme on a device', async () => {
    isNative.mockReturnValue(true);
    const svc = service();
    await svc.init(); // system, OS light → resolved light
    expect(setStyle).toHaveBeenLastCalledWith({ style: 'LIGHT' });

    svc.setPreference('dark');
    expect(setStyle).toHaveBeenLastCalledWith({ style: 'DARK' });
  });

  it('leaves the status bar alone on the web', async () => {
    const svc = service(); // isNativePlatform → false
    await svc.init();
    svc.setPreference('dark');

    expect(setStyle).not.toHaveBeenCalled();
  });

  it('defaults to the trinity palette, applying no data-theme attribute', async () => {
    const svc = service();
    await svc.init();

    expect(svc.palette()).toBe('trinity');
    expect(paletteAttr()).toBeNull();
  });

  it('restores a saved palette and reflects it as the data-theme attribute', async () => {
    get.mockImplementation(({ key }: { key: string }) =>
      Promise.resolve({ value: key === 'trinity.palette' ? 'amethyst' : null }),
    );
    const svc = service();
    await svc.init();

    expect(svc.palette()).toBe('amethyst');
    expect(paletteAttr()).toBe('amethyst');
  });

  it('setPalette applies + persists, and switching back clears the attribute', async () => {
    const svc = service();
    await svc.init();

    svc.setPalette('amethyst');
    expect(svc.palette()).toBe('amethyst');
    expect(paletteAttr()).toBe('amethyst');
    expect(set).toHaveBeenCalledWith({
      key: 'trinity.palette',
      value: 'amethyst',
    });

    svc.setPalette('trinity');
    expect(paletteAttr()).toBeNull();
  });

  it('ignores an unknown saved palette, keeping the default', async () => {
    get.mockImplementation(({ key }: { key: string }) =>
      Promise.resolve({ value: key === 'trinity.palette' ? 'bogus' : null }),
    );
    const svc = service();
    await svc.init();

    expect(svc.palette()).toBe('trinity');
    expect(paletteAttr()).toBeNull();
  });

  it('keeps palette and mode independent', async () => {
    const svc = service();
    await svc.init();

    svc.setPalette('amethyst');
    svc.setPreference('dark');

    // Both axes apply at once: dark class AND the palette attribute.
    expect(isDark()).toBe(true);
    expect(paletteAttr()).toBe('amethyst');
  });
});

/**
 * Text size. The lever is the ROOT font size, so everything that inherits from it scales —
 * message bodies, all rendered markdown, and the Tailwind-typed settings area.
 */
describe('ThemeService text scale', () => {
  function service(): ThemeService {
    TestBed.configureTestingModule({});
    return TestBed.inject(ThemeService);
  }
  const rootSize = () => document.documentElement.style.fontSize;

  beforeEach(() => {
    get.mockReset();
    set.mockReset();
    get.mockResolvedValue({ value: null });
    // The service does `Preferences.set(...).catch(...)`, so the mock has to return a
    // promise — a bare mockReset leaves it returning undefined and the call throws.
    set.mockResolvedValue(undefined);
    document.documentElement.style.removeProperty('font-size');
  });
  afterEach(() => document.documentElement.style.removeProperty('font-size'));

  it('leaves the root untouched at the default size', async () => {
    const svc = service();
    await svc.init();

    expect(svc.textScale()).toBe('default');
    // No inline style at all, rather than an explicit 100%: an unscaled app must leave
    // whatever the browser or a user stylesheet says alone.
    expect(rootSize()).toBe('');
  });

  it('applies and persists a larger size as a PERCENTAGE', async () => {
    const svc = service();
    await svc.init();

    svc.setTextScale('larger');

    // A percentage, not px: it is relative to whatever the browser is already set to, so
    // someone who has raised their default keeps it. A px value would silently override an
    // accessibility setting they had already made.
    expect(rootSize()).toBe('125%');
    expect(set).toHaveBeenCalledWith({
      key: 'trinity.text-scale',
      value: 'larger',
    });
  });

  it('restores a saved size on init', async () => {
    get.mockImplementation(({ key }: { key: string }) =>
      Promise.resolve({ value: key === 'trinity.text-scale' ? 'small' : null }),
    );
    const svc = service();
    await svc.init();

    expect(svc.textScale()).toBe('small');
    expect(rootSize()).toBe('87.5%');
  });

  it('clears the inline size when going back to default', async () => {
    const svc = service();
    await svc.init();
    svc.setTextScale('large');
    expect(rootSize()).toBe('112.5%');

    svc.setTextScale('default');

    expect(rootSize()).toBe('');
  });

  it('ignores a stored value that is not a registered scale', async () => {
    get.mockImplementation(({ key }: { key: string }) =>
      Promise.resolve({ value: key === 'trinity.text-scale' ? 'huge' : null }),
    );
    const svc = service();
    await svc.init();

    expect(svc.textScale()).toBe('default');
    expect(rootSize()).toBe('');
  });
});
