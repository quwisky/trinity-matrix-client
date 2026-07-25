import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DateTimeFormatService } from './date-time-format.service';

const store = new Map<string, string>();
let failStorage = false;

// The service talks to @capacitor/preferences directly (the repo's preference pattern), so
// stub the plugin with an in-memory map rather than the whole native layer.
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => {
      if (failStorage) {
        throw new Error('storage unavailable');
      }
      return { value: store.get(key) ?? null };
    },
    set: async ({ key, value }: { key: string; value: string }) => {
      store.set(key, value);
    },
  },
}));

const TIME_KEY = 'trinity.format.time';
const DATE_KEY = 'trinity.format.date';

/** Local wall-clock instant, so assertions hold in any timezone. */
const AFTERNOON = new Date(2026, 6, 24, 15, 45).getTime();

describe('DateTimeFormatService', () => {
  beforeEach(() => {
    store.clear();
    failStorage = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function make(): DateTimeFormatService {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [DateTimeFormatService] });
    return TestBed.inject(DateTimeFormatService);
  }

  it('defaults both axes to Match system', () => {
    const svc = make();

    expect(svc.timeFormat()).toBe('system');
    expect(svc.dateFormat()).toBe('system');
  });

  it('persists each choice and restores it on the next launch', async () => {
    const first = make();
    first.setTimeFormat('h24');
    first.setDateFormat('iso');

    expect(store.get(TIME_KEY)).toBe('h24');
    expect(store.get(DATE_KEY)).toBe('iso');

    const second = make();
    expect(second.timeFormat()).toBe('system'); // not hydrated yet
    await second.init();

    expect(second.timeFormat()).toBe('h24');
    expect(second.dateFormat()).toBe('iso');
  });

  it('keeps the defaults when storage is unavailable', async () => {
    failStorage = true;
    const svc = make();
    await svc.init();

    expect(svc.timeFormat()).toBe('system');
    expect(svc.dateFormat()).toBe('system');
  });

  // This feeds every timestamp in the app, so an unrecognised stored value must not propagate
  // — it would render "undefined" in every message header rather than failing loudly.
  it('falls back to the default for a stored value it does not recognise', async () => {
    store.set(TIME_KEY, '12h'); // plausible-looking, but not an id we ship
    store.set(DATE_KEY, 'ymd');

    const svc = make();
    await svc.init();

    expect(svc.timeFormat()).toBe('system');
    expect(svc.dateFormat()).toBe('system');
    expect(svc.dateTime(AFTERNOON)).not.toContain('undefined');
  });

  it('changes the two axes independently', () => {
    const svc = make();

    svc.setTimeFormat('h24');
    expect(svc.dateFormat()).toBe('system');

    svc.setDateFormat('dmy');
    expect(svc.timeFormat()).toBe('h24');
  });

  // The row cache in the timeline depends on this: a fresh object per read would make the
  // `rows()` computed re-derive on every change-detection pass and cost every row its identity.
  it('keeps prefs identity stable until something actually changes', () => {
    const svc = make();
    const before = svc.prefs();

    expect(svc.prefs()).toBe(before);

    svc.setTimeFormat('h24');
    expect(svc.prefs()).not.toBe(before);
    expect(svc.prefs()).toBe(svc.prefs());
  });

  it('formats through the current preference', () => {
    const svc = make();

    svc.setTimeFormat('h24');
    svc.setDateFormat('iso');

    expect(svc.time(AFTERNOON)).toBe('15:45');
    expect(svc.dateOnly(AFTERNOON)).toBe('2026-07-24');
    expect(svc.dateTime(AFTERNOON)).toBe('2026-07-24, 15:45');
    expect(svc.longDateTime(AFTERNOON)).toBe('2026-07-24, 15:45:00');
  });

  // The settings page previews options the user has NOT chosen, so the samples must ignore the
  // current preference on that axis while respecting the other.
  it('samples an option without changing the stored preference', () => {
    const svc = make();
    svc.setTimeFormat('h24');

    expect(svc.sampleTime(AFTERNOON, 'h12')).toContain('3:45');
    expect(svc.sampleDate(AFTERNOON, 'dmy')).toBe('24/07/2026');

    expect(svc.timeFormat()).toBe('h24');
    expect(svc.dateFormat()).toBe('system');
  });

  it('re-reads the locale chain when the OS language changes', () => {
    const svc = make();
    const before = svc.prefs().locales;

    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['de-DE', 'en-US']);
    window.dispatchEvent(new Event('languagechange'));

    expect(svc.prefs().locales).not.toEqual(before);
    expect(svc.prefs().locales).toEqual(['de-DE', 'en-US']);
  });
});
