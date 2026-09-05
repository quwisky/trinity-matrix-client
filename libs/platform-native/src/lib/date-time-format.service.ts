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
 * The reader's locale chain, most-preferred first.
 *
 * `navigator.languages` rather than `navigator.language`: the full chain lets `Intl` negotiate
 * down when the engine lacks data for the first tag, where a single tag would instead fall
 * through to the *runtime* default — `en-US` under jsdom and in the Electron shell, quietly
 * reinstating the very bug this preference exists to fix.
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
 * **Not defensive programming — this throws in the wild.** Chromium derives
 * `navigator.languages` from the OS locale, and a POSIX-style one (`LANG=en_US`, `C`, or an
 * `@posix` modifier) arrives as `en-US@posix`, which is not valid BCP-47. The chain is
 * handed straight to `new Intl.DateTimeFormat(...)` in `date-format.ts`, and that
 * constructor throws a `RangeError` on a malformed tag. Because the timeline formats
 * timestamps *while it renders*, the throw lands inside change detection: no timestamp, no
 * message, no room — the screen is simply blank, with a `RangeError` in the console and
 * nothing to connect it to a locale.
 *
 * Filtered per tag rather than all-or-nothing, so one bad entry cannot cost the reader the
 * rest of their preference order. `undefined` rather than `[]` when nothing survives: an
 * empty array is a legal argument meaning "no preference", but it is a distinct cache key
 * downstream and would misreport what we know.
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
 * The single choke point for every timestamp the app renders — how the clock is shown
 * (12/24-hour) and how a date is ordered, persisted per device.
 *
 * Components call the format methods straight from their templates rather than through a
 * pipe. That is deliberate: a *pure* pipe caches on its input, so a timestamp that never
 * changes would skip `transform()` entirely, never re-read the preference signal, and — worse —
 * have its producer link trimmed, leaving the view permanently deaf to the setting. A method
 * invoked from the template re-registers the dependency on every pass, so an OnPush view
 * refreshes when the preference moves even though none of its inputs changed.
 *
 * Device-scoped, like the theme and the other UI preferences: non-secret, so Capacitor
 * `Preferences` rather than secure storage.
 */
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
   * Everything the pure formatters need, as one value.
   *
   * A `computed`, emphatically not a getter returning a fresh literal: the timeline's `rows()`
   * reads this, and a new object identity on every read would make that computed re-derive on
   * every change-detection pass, costing every row its cached identity and turning the row
   * cache into a pessimisation.
   */
  readonly prefs = computed<DateTimePrefs>(() => ({
    locales: this._locales(),
    time: this._timeFormat(),
    date: this._dateFormat(),
  }));

  constructor() {
    // The OS language can change under a running app (and a Capacitor WebView is long-lived),
    // which moves what "Match system" means. Like Appearance's system-Mode source, this is
    // guarded for the non-DOM contexts the rest of the library supports.
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
 * the default rather than propagating: this feeds every timestamp in the app, so a stale or
 * hand-edited key would otherwise render `undefined` app-wide.
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
