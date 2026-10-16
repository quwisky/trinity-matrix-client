import { Injectable, type OnDestroy } from '@angular/core';
import { Preferences } from '@capacitor/preferences';

const DRAFTS_KEY = 'trinity.composer.drafts';
/** Coalesce a burst of keystrokes into one persist (ms). */
const PERSIST_DEBOUNCE_MS = 400;
/** Bound the stored set so stale drafts can't grow without limit. */
const MAX_DRAFTS = 200;

/**
 * Per-conversation composer drafts, persisted across launches under an opaque conversation
 * key (an Account-and-Room key for the main composer, the root event id for the legacy
 * thread composer). Held in Capacitor `Preferences`, not secure storage.
 *
 * Read synchronously from memory; {@link init} must load the saved map before any
 * composer mounts. Writes are debounced.
 */
@Injectable({ providedIn: 'root' })
export class DraftStoreService implements OnDestroy {
  private drafts = new Map<string, string>();
  private pending: ReturnType<typeof setTimeout> | null = null;
  private initialised = false;

  /**
   * Drop a pending write when the injector goes away: under test a late write lands after
   * the module is torn down, where `Preferences.set` is no longer a promise, and the run
   * fails on an uncaught TypeError with every test passing.
   *
   * `ngOnDestroy` rather than `inject(DestroyRef)` so a test can still build an instance
   * with `new` to pre-seed it.
   */
  ngOnDestroy(): void {
    this.cancelPending();
  }

  /** Load persisted drafts. Call once at app startup, before the composer renders. */
  async init(): Promise<void> {
    try {
      const { value } = await Preferences.get({ key: DRAFTS_KEY });
      if (value) {
        const parsed = JSON.parse(value) as Record<string, unknown>;
        this.drafts = new Map(
          Object.entries(parsed).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        );
      }
    } catch {
      // Absent or corrupt: start empty.
    }
    this.initialised = true;
  }

  /** Whether {@link init} has loaded the stored drafts; before that the map is empty. */
  isInitialised(): boolean {
    return this.initialised;
  }

  /** The saved draft for a conversation, or '' when none. */
  get(key: string): string {
    return this.drafts.get(key) ?? '';
  }

  /** Save the draft for a conversation; a blank draft drops the entry. */
  set(key: string, text: string): void {
    if (text.trim().length > 0) {
      this.drafts.set(key, text);
    } else {
      this.drafts.delete(key);
    }
    this.schedulePersist();
  }

  /** Drop a conversation's draft (e.g. after its message is sent). */
  clear(key: string): void {
    if (this.drafts.delete(key)) {
      this.schedulePersist();
    }
  }

  /**
   * Drop every draft, in memory and on disk, for sign-out.
   *
   * A draft is the plaintext of a message destined for an encrypted room, so it must not
   * outlive the session that wrote it; on web/Electron the store is localStorage, readable
   * by whoever next uses the browser profile. The pending write is cancelled first, or it
   * would re-persist the map 400ms after the wipe.
   *
   * All drafts share one persisted collection and legacy thread keys carry no Account, so
   * signing one of several accounts out clears all drafts. Losing a draft is recoverable;
   * leaking one is not.
   */
  clearAll(): void {
    this.cancelPending();
    this.drafts = new Map();
    // Wrapped as in persist(): a `.catch` on a non-promise throws synchronously.
    void Promise.resolve(Preferences.remove({ key: DRAFTS_KEY })).catch(
      () => undefined,
    );
  }

  /**
   * Write the drafts now, for a page about to restart: a debounced write would be lost
   * with the page. Never rejects. Before {@link init} has loaded them it writes nothing,
   * since the empty map would erase the stored drafts.
   */
  flush(): Promise<void> {
    if (!this.initialised) return Promise.resolve();
    this.cancelPending();
    return this.persist();
  }

  private schedulePersist(): void {
    if (this.pending !== null) {
      return;
    }
    this.pending = setTimeout(() => {
      this.pending = null;
      void this.persist();
    }, PERSIST_DEBOUNCE_MS);
  }

  private cancelPending(): void {
    if (this.pending !== null) {
      clearTimeout(this.pending);
      this.pending = null;
    }
  }

  private persist(): Promise<void> {
    const record: Record<string, string> = {};
    for (const [key, text] of [...this.drafts.entries()].slice(-MAX_DRAFTS)) {
      record[key] = text;
    }
    // Promise.resolve wraps the SDK call: a `.catch` straight onto a non-promise throws
    // synchronously out of a timer callback, where nothing can catch it.
    return Promise.resolve(
      Preferences.set({ key: DRAFTS_KEY, value: JSON.stringify(record) }),
    ).then(
      () => undefined,
      () => undefined,
    );
  }
}
