import { Injectable, signal } from '@angular/core';
import { Preferences } from '@capacitor/preferences';

const SEND_READ_RECEIPTS_KEY = 'trinity.privacy.send-read-receipts';
const LINK_PREVIEWS_KEY = 'trinity.privacy.link-previews';
const LINK_PREVIEWS_ENCRYPTED_KEY = 'trinity.privacy.link-previews-encrypted';

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
  private readonly _linkPreviews = signal(true);
  private readonly _linkPreviewsInEncrypted = signal(false);

  /**
   * Whether this device sends *public* read receipts (`m.read`) others can see.
   * On by default. When off, the app still acks messages so your own unread
   * badges clear — but privately (`m.read.private`), invisible to other users.
   */
  readonly sendReadReceipts = this._sendReadReceipts.asReadonly();

  /**
   * Whether to show link previews for URLs in messages. On by default. Previews are
   * fetched via the homeserver; in unencrypted rooms that's a link the server already
   * sees, so it's safe by default. This switch turns them off entirely.
   */
  readonly linkPreviews = this._linkPreviews.asReadonly();

  /**
   * Whether to ALSO show link previews in end-to-end-encrypted rooms. Off by default:
   * fetching a preview sends the URL from an otherwise-encrypted message to the
   * homeserver's preview service, disclosing a link the server couldn't otherwise see.
   * Only consulted when {@link linkPreviews} is on.
   */
  readonly linkPreviewsInEncrypted = this._linkPreviewsInEncrypted.asReadonly();

  /** Read the saved preferences and apply them. Call once at app startup. */
  async init(): Promise<void> {
    this._sendReadReceipts.set(await this.read(SEND_READ_RECEIPTS_KEY, true));
    this._linkPreviews.set(await this.read(LINK_PREVIEWS_KEY, true));
    this._linkPreviewsInEncrypted.set(
      await this.read(LINK_PREVIEWS_ENCRYPTED_KEY, false),
    );
  }

  /** Toggle + persist whether this device sends public read receipts. */
  setSendReadReceipts(on: boolean): void {
    this._sendReadReceipts.set(on);
    this.persist(SEND_READ_RECEIPTS_KEY, on);
  }

  /** Toggle + persist whether link previews are shown. */
  setLinkPreviews(on: boolean): void {
    this._linkPreviews.set(on);
    this.persist(LINK_PREVIEWS_KEY, on);
  }

  /** Toggle + persist whether link previews are also shown in encrypted rooms. */
  setLinkPreviewsInEncrypted(on: boolean): void {
    this._linkPreviewsInEncrypted.set(on);
    this.persist(LINK_PREVIEWS_ENCRYPTED_KEY, on);
  }

  private async read(key: string, fallback: boolean): Promise<boolean> {
    try {
      const { value } = await Preferences.get({ key });
      return value === null ? fallback : value === 'true';
    } catch {
      return fallback; // storage unavailable → keep the default
    }
  }

  private persist(key: string, on: boolean): void {
    void Preferences.set({ key, value: String(on) }).catch(() => undefined);
  }
}
