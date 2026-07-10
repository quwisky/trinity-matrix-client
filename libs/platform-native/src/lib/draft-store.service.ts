import { Injectable } from '@angular/core';
import { Preferences } from '@capacitor/preferences';

const DRAFTS_KEY = 'trinity.composer.drafts';
/** Coalesce a burst of keystrokes into one persist (ms). */
const PERSIST_DEBOUNCE_MS = 400;
/** Bound the stored set so stale drafts can't grow without limit. */
const MAX_DRAFTS = 200;

/**
 * Per-conversation composer drafts, persisted across launches. Keyed by a
 * conversation id — a room id for the main composer, a thread's root event id for
 * the thread composer (disjoint namespaces, so they never collide). Like the theme
 * and feature flags, these are non-secret UI state, so they live in Capacitor
 * `Preferences` (localStorage on web, native KV on device), never secure storage.
 *
 * Held in memory and read synchronously; {@link init} (called at startup) loads the
 * saved map before any composer mounts, and writes are debounced.
 */
@Injectable({ providedIn: 'root' })
export class DraftStoreService {
  private drafts = new Map<string, string>();
  private persistScheduled = false;

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
      // Absent or corrupt → start empty.
    }
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

  private schedulePersist(): void {
    if (this.persistScheduled) {
      return;
    }
    this.persistScheduled = true;
    setTimeout(() => {
      this.persistScheduled = false;
      this.persist();
    }, PERSIST_DEBOUNCE_MS);
  }

  private persist(): void {
    // Keep only the most recently inserted MAX_DRAFTS to bound storage. Build the
    // record with a loop (not Object.fromEntries) — the lib targets es2018.
    const record: Record<string, string> = {};
    for (const [key, text] of [...this.drafts.entries()].slice(-MAX_DRAFTS)) {
      record[key] = text;
    }
    void Preferences.set({
      key: DRAFTS_KEY,
      value: JSON.stringify(record),
    }).catch(() => undefined);
  }
}
