import { Injectable, signal, type WritableSignal } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import {
  combinePreferenceInitialization,
  preferenceInitializationDefaulted,
  preferenceInitializationReady,
  type PreferenceInitializationOutcome,
  type PreferenceInitializationRead,
} from './preference-initialization';

const VIRTUAL_TIMELINE_KEY = 'trinity.flags.virtual-timeline';
const DEFER_MEDIA_WHILE_SCROLLING_KEY =
  'trinity.flags.defer-media-while-scrolling';
const FLING_PLACEHOLDERS_KEY = 'trinity.flags.fling-placeholders';

/** The windowed timeline is on unless the user opts out. */
export const DEFAULT_VIRTUAL_TIMELINE = true;

/** Timeline images load as their rows mount unless the user opts in to waiting. */
export const DEFAULT_DEFER_MEDIA_WHILE_SCROLLING = false;

/** Every timeline row renders in full during a fast scroll unless the user opts in. */
export const DEFAULT_FLING_PLACEHOLDERS = false;

/**
 * User-toggleable experimental feature flags, persisted across launches.
 *
 * These are non-secret UI preferences, so — like the theme — they live in
 * Capacitor `Preferences` (the non-secure key/value store, backed by
 * localStorage on web and native KV on device), never in secure storage, which
 * is reserved for the access token. Exposed as signals so the settings UI can
 * bind them and feature code can react.
 */
@Injectable({ providedIn: 'root' })
export class FeatureFlagsService {
  private readonly _virtualTimeline = signal(DEFAULT_VIRTUAL_TIMELINE);
  private readonly _deferMediaWhileScrolling = signal(
    DEFAULT_DEFER_MEDIA_WHILE_SCROLLING,
  );
  private readonly _flingPlaceholders = signal(DEFAULT_FLING_PLACEHOLDERS);

  /**
   * Windowed (virtualized) message timeline: render only the on-screen rows plus
   * spacers so the DOM stays bounded in long rooms.
   *
   * ON by default. The non-windowed list renders every loaded row and nothing caps
   * retention — the auto-backfill alone pulls up to 600 rows to fill the viewport, and
   * every scroll-to-top adds 30 more for the life of the session, each a heavy subtree
   * (avatar, toolbar, reactions, receipts, previews). An explicit stored preference
   * still wins, so anyone who opted out keeps that; Settings → Experimental toggles it.
   */
  readonly virtualTimeline = this._virtualTimeline.asReadonly();

  /**
   * Timeline images (and video posters) wait to load until their row is near the
   * viewport and the list is no longer scrolling fast. A fast scroll otherwise fetches,
   * decodes and uploads to the GPU every image it passes. OFF by default: an opt-in in
   * Settings → Experimental.
   */
  readonly deferMediaWhileScrolling =
    this._deferMediaWhileScrolling.asReadonly();

  /**
   * While the timeline moves faster than anyone reads, rows entering the window render as
   * blank placeholders of their known (or estimated) height, and the real rows mount once
   * the scroll slows or stops. A fast scroll otherwise builds and throws away about a
   * hundred full rows a second. OFF by default: an opt-in in Settings → Experimental.
   */
  readonly flingPlaceholders = this._flingPlaceholders.asReadonly();

  /** Read the saved flags and apply them. Call once at app startup. */
  async init(): Promise<PreferenceInitializationOutcome> {
    const outcomes = await Promise.all([
      this.restore(VIRTUAL_TIMELINE_KEY, this._virtualTimeline),
      this.restore(
        DEFER_MEDIA_WHILE_SCROLLING_KEY,
        this._deferMediaWhileScrolling,
      ),
      this.restore(FLING_PLACEHOLDERS_KEY, this._flingPlaceholders),
    ]);
    return combinePreferenceInitialization(outcomes);
  }

  /** Toggle + persist the virtualized-timeline flag. */
  setVirtualTimeline(on: boolean): void {
    this._virtualTimeline.set(on);
    this.persist(VIRTUAL_TIMELINE_KEY, on);
  }

  /** Toggle + persist whether timeline images wait for a fast scroll to slow down. */
  setDeferMediaWhileScrolling(on: boolean): void {
    this._deferMediaWhileScrolling.set(on);
    this.persist(DEFER_MEDIA_WHILE_SCROLLING_KEY, on);
  }

  /** Toggle + persist whether rows flying past in a fast scroll render as placeholders. */
  setFlingPlaceholders(on: boolean): void {
    this._flingPlaceholders.set(on);
    this.persist(FLING_PLACEHOLDERS_KEY, on);
  }

  /** Apply one stored flag, keeping its default when nothing valid is stored. */
  private async restore(
    key: string,
    flag: WritableSignal<boolean>,
  ): Promise<PreferenceInitializationOutcome> {
    const { value, outcome } = await this.read(key);
    if (value !== null) flag.set(value);
    return outcome;
  }

  private async read(
    key: string,
  ): Promise<PreferenceInitializationRead<boolean | null>> {
    try {
      const { value } = await Preferences.get({ key });
      if (value === null) {
        return { value: null, outcome: preferenceInitializationReady };
      }
      if (value !== 'true' && value !== 'false') {
        return {
          value: null,
          outcome: preferenceInitializationDefaulted('invalid-stored-value'),
        };
      }
      return {
        value: value === 'true',
        outcome: preferenceInitializationReady,
      };
    } catch {
      return {
        value: null,
        outcome: preferenceInitializationDefaulted('storage-unavailable'),
      };
    }
  }

  private persist(key: string, on: boolean): void {
    void Preferences.set({ key, value: String(on) }).catch(() => undefined);
  }
}
