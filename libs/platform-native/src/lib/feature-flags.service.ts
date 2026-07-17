import { Injectable, signal } from '@angular/core';
import { Preferences } from '@capacitor/preferences';

const VIRTUAL_TIMELINE_KEY = 'trinity.flags.virtual-timeline';

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
  private readonly _virtualTimeline = signal(true);
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

  /** Read the saved flags and apply them. Call once at app startup. */
  async init(): Promise<void> {
    try {
      const { value } = await Preferences.get({ key: VIRTUAL_TIMELINE_KEY });
      if (value !== null) {
        this._virtualTimeline.set(value === 'true');
      }
    } catch {
      // No stored value (or storage unavailable) → keep the default (on).
    }
  }

  /** Toggle + persist the virtualized-timeline flag. */
  setVirtualTimeline(on: boolean): void {
    this._virtualTimeline.set(on);
    void Preferences.set({
      key: VIRTUAL_TIMELINE_KEY,
      value: String(on),
    }).catch(() => undefined);
  }
}
