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
import { ThemeService } from './theme.service';

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(), set: vi.fn() },
}));

const get = Preferences.get as unknown as Mock;
const set = Preferences.set as unknown as Mock;

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
    mql = makeMql(false); // system = light by default
    origMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn(
      () => mql as unknown as MediaQueryList,
    ) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    window.matchMedia = origMatchMedia;
    document.documentElement.classList.remove('ion-palette-dark');
  });

  function service(): ThemeService {
    TestBed.configureTestingModule({ providers: [ThemeService] });
    return TestBed.inject(ThemeService);
  }

  // The dark palette is the `.ion-palette-dark` class on <html> (light is default).
  const isDark = () =>
    document.documentElement.classList.contains('ion-palette-dark');

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
});
