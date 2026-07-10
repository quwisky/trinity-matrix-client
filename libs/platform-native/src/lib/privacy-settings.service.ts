import { Injectable, signal } from '@angular/core';
import { Preferences } from '@capacitor/preferences';

const SEND_READ_RECEIPTS_KEY = 'trinity.privacy.send-read-receipts';

/**
 * Device-scoped privacy preferences, persisted across launches.
 *
 * Like the {@link FeatureFlagsService} feature flags and the theme, these are
 * non-secret UI preferences, so they live in Capacitor `Preferences` (the
 * non-secure key/value store, backed by localStorage on web and native KV on
 * device), never in secure storage. They're per-device on purpose: whether this
 * device broadcasts your reading activity is a local choice, matching how other
 * Matrix clients treat it. Exposed as signals so the settings UI can bind them
 * and the timeline/thread receipt code can react.
 */
@Injectable({ providedIn: 'root' })
export class PrivacySettingsService {
  private readonly _sendReadReceipts = signal(true);

  /**
   * Whether this device sends *public* read receipts (`m.read`) others can see.
   * On by default. When off, the app still acks messages so your own unread
   * badges clear — but privately (`m.read.private`), invisible to other users.
   */
  readonly sendReadReceipts = this._sendReadReceipts.asReadonly();

  /** Read the saved preferences and apply them. Call once at app startup. */
  async init(): Promise<void> {
    try {
      const { value } = await Preferences.get({ key: SEND_READ_RECEIPTS_KEY });
      if (value !== null) {
        this._sendReadReceipts.set(value === 'true');
      }
    } catch {
      // No stored value (or storage unavailable) → keep the default (on).
    }
  }

  /** Toggle + persist whether this device sends public read receipts. */
  setSendReadReceipts(on: boolean): void {
    this._sendReadReceipts.set(on);
    void Preferences.set({
      key: SEND_READ_RECEIPTS_KEY,
      value: String(on),
    }).catch(() => undefined);
  }
}
