import {
  DestroyRef,
  Injectable,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import {
  DEFAULT_DATE_FORMAT,
  DEFAULT_TIME_FORMAT,
  TRINITY_DATE_FORMATS,
  TRINITY_TIME_FORMATS,
  formatClockTime,
  formatDateOnly,
  formatDateTime,
  isDateFormat,
  isTimeFormat,
  type DateFormat,
  type DateTimePrefs,
  type TimeFormat,
} from '@trinity/util/matrix';
import {
  combinePreferenceInitialization,
  preferenceInitializationDefaulted,
  preferenceInitializationReady,
  type PreferenceInitializationOutcome,
  type PreferenceInitializationRead,
} from './preference-initialization';

const TIME_KEY = 'trinity.format.time';
const DATE_KEY = 'trinity.format.date';

/**
 * The reader's locale chain, most-preferred first. The full `navigator.languages` chain lets
 * `Intl` negotiate down when the engine lacks the first tag; a single tag would fall through
 * to the runtime default (`en-US` under jsdom and in the Electron shell).
 */
function systemLocales(): readonly string[] | undefined {
  if (typeof navigator === 'undefined') {
    return undefined;
  }
  const chain = navigator.languages;
  const raw = chain?.length
    ? [...chain]
    : navigator.language
      ? [navigator.language]
      : undefined;
  return usable(raw);
}

/**
 * The tags `Intl` will actually accept, or `undefined` if none of them are.
 *
 * Needed in practice: Chromium derives `navigator.languages` from the OS locale, and a
 * POSIX-style one (`LANG=en_US`, `C`, an `@posix` modifier) arrives as `en-US@posix`, which
 * is not valid BCP-47. `new Intl.DateTimeFormat(...)` throws a `RangeError` on it, and since
 * timestamps format during render, the throw blanks the screen.
 *
 * Filtered per tag so one bad entry cannot cost the rest of the preference order.
 * `undefined` rather than `[]` when nothing survives: `[]` is a distinct cache key downstream.
 */
function usable(
  tags: readonly string[] | undefined,
): readonly string[] | undefined {
  if (!tags?.length) {
    return undefined;
  }
  const accepted = tags.filter((tag) => {
    try {
      Intl.getCanonicalLocales(tag);
      return true;
    } catch {
      return false;
    }
  });
  return accepted.length ? accepted : undefined;
}

/**
 * Every rendered timestamp goes through here: clock style (12/24-hour) and date order,
 * persisted per device in Capacitor `Preferences` (non-secret).
 *
 * Components call these methods from templates instead of a pipe: a pure pipe caches on its
 * input, never re-reads the preference signal, and can lose its dependency link, leaving the
 * view deaf to the setting. A template method re-registers the dependency every pass.
 */
const YEAR_SECONDS = 365 * 86_400;

/** Each relative unit, its size in seconds, and where the next, larger unit takes over. */
const RELATIVE_UNITS: readonly (readonly [
  Intl.RelativeTimeFormatUnit,
  number,
  number,
])[] = [
  ['minute', 60, 3_600],
  ['hour', 3_600, 86_400],
  ['day', 86_400, 7 * 86_400],
  ['week', 7 * 86_400, 30 * 86_400],
  ['month', 30 * 86_400, YEAR_SECONDS],
];

@Injectable({ providedIn: 'root' })
export class DateTimeFormatService {
  private readonly _timeFormat = signal<TimeFormat>(DEFAULT_TIME_FORMAT);
  /** How the clock is rendered. */
  readonly timeFormat = this._timeFormat.asReadonly();

  private readonly _dateFormat = signal<DateFormat>(DEFAULT_DATE_FORMAT);
  /** How a numeric date is ordered. */
  readonly dateFormat = this._dateFormat.asReadonly();

  private readonly _locales = signal<readonly string[] | undefined>(
    systemLocales(),
  );

  /** The options to offer in the UI. */
  readonly timeFormats = TRINITY_TIME_FORMATS;
  readonly dateFormats = TRINITY_DATE_FORMATS;

  /**
   * Everything the pure formatters need, as one value. Must stay a `computed`: a fresh object
   * identity per read would make the timeline's `rows()` re-derive every pass and defeat its
   * row cache.
   */
  readonly prefs = computed<DateTimePrefs>(() => ({
    locales: this._locales(),
    time: this._timeFormat(),
    date: this._dateFormat(),
  }));

  constructor() {
    // The OS language can change under a running app, which moves what "Match system" means.
    // Guarded for non-DOM contexts.
    const target = typeof window !== 'undefined' ? window : null;
    const onLanguageChange = () => this._locales.set(systemLocales());
    target?.addEventListener('languagechange', onLanguageChange);
    inject(DestroyRef).onDestroy(() =>
      target?.removeEventListener('languagechange', onLanguageChange),
    );
  }

  /** Read the saved preferences and apply them. Call once at app startup. */
  async init(): Promise<PreferenceInitializationOutcome> {
    const [time, date] = await Promise.all([
      read(TIME_KEY, isTimeFormat, DEFAULT_TIME_FORMAT),
      read(DATE_KEY, isDateFormat, DEFAULT_DATE_FORMAT),
    ]);
    this._timeFormat.set(time.value);
    this._dateFormat.set(date.value);
    return combinePreferenceInitialization([time.outcome, date.outcome]);
  }

  /** Change + persist how the clock is rendered. */
  setTimeFormat(format: TimeFormat): void {
    this._timeFormat.set(format);
    persist(TIME_KEY, format);
  }

  /** Change + persist how a date is ordered. */
  setDateFormat(format: DateFormat): void {
    this._dateFormat.set(format);
    persist(DATE_KEY, format);
  }

  /** Clock time alone — the hover gutter on a grouped message. */
  time(ts: number): string {
    return formatClockTime(ts, this.prefs());
  }

  /** Date and time together — the shape most of the app shows. */
  dateTime(ts: number): string {
    return formatDateTime(ts, this.prefs());
  }

  /** Date and time down to the second — edit history, where versions can be seconds apart. */
  longDateTime(ts: number): string {
    return formatDateTime(ts, this.prefs(), true);
  }

  /** A numeric date alone. */
  dateOnly(ts: number): string {
    return formatDateOnly(ts, this.prefs());
  }

  /**
   * How long ago `ts` was, from `now`, in the reader's language: "now", "2 min. ago",
   * "yesterday", "3 wk. ago", "2 yr. ago". The largest unit that fits, so old activity never
   * reads as hundreds of days.
   */
  relative(ts: number, now: number): string {
    const format = new Intl.RelativeTimeFormat(
      this.prefs().locales as string[],
      {
        numeric: 'auto',
        style: 'short',
      },
    );
    const seconds = Math.round((ts - now) / 1000);
    const past = Math.abs(seconds);
    if (past < 45) return format.format(0, 'second');
    for (const [unit, size, next] of RELATIVE_UNITS) {
      if (past < next) return format.format(Math.round(seconds / size), unit);
    }
    return format.format(Math.round(seconds / YEAR_SECONDS), 'year');
  }

  /** The short weekday, as "Wed", in the reader's language. */
  weekday(ts: number): string {
    return new Intl.DateTimeFormat(this.prefs().locales as string[], {
      weekday: 'short',
    }).format(ts);
  }

  /** The month, with the year when asked, as "October" or "October 2025". */
  month(ts: number, withYear: boolean): string {
    return new Intl.DateTimeFormat(this.prefs().locales as string[], {
      month: 'long',
      ...(withYear ? { year: 'numeric' } : {}),
    }).format(ts);
  }

  /** How `ts` would read under `time`, for previewing an option the user has not picked. */
  sampleTime(ts: number, time: TimeFormat): string {
    return formatClockTime(ts, { ...this.prefs(), time });
  }

  /** How `ts` would read under `date`, for previewing an option the user has not picked. */
  sampleDate(ts: number, date: DateFormat): string {
    return formatDateOnly(ts, { ...this.prefs(), date });
  }
}

/**
 * A stored preference, validated through its type guard. An unrecognised value falls back to
 * the default: this feeds every timestamp, so a bad value would render `undefined` app-wide.
 */
async function read<T extends string>(
  key: string,
  isValid: (value: string | null) => value is T,
  fallback: T,
): Promise<PreferenceInitializationRead<T>> {
  try {
    const { value } = await Preferences.get({ key });
    if (value === null) {
      return { value: fallback, outcome: preferenceInitializationReady };
    }
    return isValid(value)
      ? { value, outcome: preferenceInitializationReady }
      : {
          value: fallback,
          outcome: preferenceInitializationDefaulted('invalid-stored-value'),
        };
  } catch {
    return {
      value: fallback,
      outcome: preferenceInitializationDefaulted('storage-unavailable'),
    };
  }
}

function persist(key: string, value: string): void {
  void Preferences.set({ key, value }).catch(() => undefined);
}
